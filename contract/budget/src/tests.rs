use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const OWNER: &str = "owner.testnet";
const ORCH: &str = "orch.testnet";
const SIGNER: &str = "signer.testnet";
const USDC: &str = "usdc.testnet";
const ME: &str = "rook.testnet";
const EVE: &str = "eve.testnet";
const CREATE: &str = r#"{"create_task":{"reserve_bps":2000,"caps":["300","200","100"]}}"#;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Storage the mocked account uses; its stake is STAKED yoctoNEAR (1e19 per byte).
const STORAGE: u64 = 100_000;
const STAKED: u128 = STORAGE as u128 * 10_000_000_000_000_000_000;

/// Sets the context: `pred` calls this contract, then `f` adjusts it (balance, deposit, block height).
fn call_ctx(pred: &str, results: Vec<PromiseResult>, f: impl FnOnce(&mut VMContextBuilder)) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .predecessor_account_id(acc(pred))
        .account_balance(NearToken::from_near(10))
        .storage_usage(STORAGE)
        .prepaid_gas(Gas::from_tgas(300));
    f(&mut b);
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn call_with(pred: &str, results: Vec<PromiseResult>) {
    call_ctx(pred, results, |_| {});
}

/// The owner with 1 yoctoNEAR attached, at block `height`.
fn owner_yocto(height: u64) {
    call_ctx(OWNER, vec![], |b| {
        b.attached_deposit(ONE_YOCTO).block_height(height);
    });
}

fn call(pred: &str) {
    call_with(pred, vec![]);
}

/// Callback context: predecessor is the contract itself, with one promise result.
fn callback(ok: bool) {
    call_with(ME, vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
}

const PK: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

fn pk() -> PublicKey {
    PK.parse().unwrap()
}

/// Default limits except a 1-unit minimum budget, so tests can use small amounts.
fn new_contract() -> Contract {
    let mut c = default_contract();
    owner_yocto(0);
    c.set_limits(U128(1), DEFAULT_MAX_OPEN_TASKS);
    c
}

fn default_contract() -> Contract {
    call(OWNER);
    Contract::new(acc(OWNER), acc(ORCH), acc(SIGNER), acc(USDC))
}

fn register(c: &mut Contract, id: &str, n: u32) {
    call(SIGNER);
    c.register_subtask_key(id.into(), n, pk());
}

fn value<T>(v: PromiseOrValue<T>) -> T {
    match v {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

fn sub_account(id: &str, n: u32) -> String {
    format!("t{id}-{n}.{ME}")
}

/// Sends USDC to the contract as `sender`; returns the refunded amount.
fn deposit(c: &mut Contract, sender: &str, amount: u128, msg: &str) -> u128 {
    call(USDC);
    value(c.ft_on_transfer(acc(sender), U128(amount), msg.into())).0
}

fn give_back(c: &mut Contract, from: &str, id: &str, n: u32, amount: u128) -> u128 {
    deposit(c, from, amount, &format!(r#"{{"return":{{"task_id":"{id}","n":{n}}}}}"#))
}

fn check(c: &Contract, id: &str) {
    assert!(c.ledger_check(id.into()), "ledger invariant broken: {:?}", c.get_task(id.into()));
}

fn task(c: &Contract, id: &str) -> Task {
    c.get_task(id.into()).unwrap()
}

fn sub(c: &Contract, id: &str, n: u32) -> Subtask {
    c.subtasks.get(&(id.to_string(), n)).unwrap().clone()
}

fn has_event(name: &str) -> bool {
    get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains(&format!(r#""event":"{name}""#)))
}

/// Contract with task "0": budget 1000, reserve 200, unallocated 800, caps 300 / 200 / 100.
fn setup() -> Contract {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, OWNER, 1000, CREATE), 0);
    check(&c, "0");
    c
}

/// The signer registers the key, the orchestrator starts the funding.
fn start_fund(c: &mut Contract, id: &str, n: u32) {
    register(c, id, n);
    call(ORCH);
    let _ = c.fund_subtask(id.into(), n);
    check(c, id);
}

fn fund(c: &mut Contract, id: &str, n: u32) {
    start_fund(c, id, n);
    callback(true);
    let _ = c.on_account_created(id.into(), n, 0);
    check(c, id);
    callback(true);
    assert!(c.on_subtask_funded(id.into(), n, 0));
    check(c, id);
}

fn top_up(c: &mut Contract, id: &str, n: u32, amount: u128, ok: bool) {
    call(ORCH);
    let _ = c.top_up(id.into(), n, U128(amount));
    check(c, id);
    callback(ok);
    assert_eq!(c.on_top_up(id.into(), n), ok);
    check(c, id);
}

fn receipt(verdict: Option<&str>) -> Receipt {
    Receipt {
        a2a_task_id: "a2a-1".into(),
        agent_handle: "luigi-check".into(),
        amount: 100_000,
        verdict: verdict.map(Into::into),
        attestation_hash: Some("ab".repeat(32)),
        payment_hash: "cd".repeat(32),
    }
}

// ---------- create_task / ft_on_transfer ----------

#[test]
fn create_task_opens_task() {
    let mut c = setup();
    assert!(has_event("task_created") && get_logs()[0].contains(r#""task_id":"0""#));
    let t = task(&c, "0");
    assert_eq!((t.budget, t.reserve, t.unallocated, t.reserve_remaining), (1000, 200, 800, 200));
    assert_eq!((t.funder, t.status), (acc(OWNER), TaskStatus::Open));
    assert_eq!(t.caps, vec![U128(300), U128(200), U128(100)]);
    assert_eq!(deposit(&mut c, OWNER, 750, CREATE), 0, "caps sum 600 = 750 - 150");
    assert!(c.get_task("1".into()).is_some());
    assert_eq!((base36(35).as_str(), base36(36).as_str()), ("z", "10"));
}

#[test]
fn ft_on_transfer_refunds_bad_messages() {
    let mut c = new_contract();
    let bad = [
        "",
        "nope",
        r#"{"foo":{}}"#,
        r#"{"create_task":{"reserve_bps":9001,"caps":["1"]}}"#,
        r#"{"create_task":{"caps":["1"]}}"#,
        r#"{"create_task":{"reserve_bps":2000}}"#,
        r#"{"create_task":{"reserve_bps":2000,"caps":[300]}}"#,
    ];
    for msg in bad {
        assert_eq!(deposit(&mut c, OWNER, 1000, msg), 1000, "msg {msg}");
    }
    assert_eq!(c.get_config().tasks, 0);
}

#[test]
fn create_task_refunds_bad_caps() {
    let mut c = new_contract();
    let caps = |v: Vec<u128>| {
        let v: Vec<String> = v.iter().map(|c| format!(r#""{c}""#)).collect();
        format!(r#"{{"create_task":{{"reserve_bps":2000,"caps":[{}]}}}}"#, v.join(","))
    };
    for (v, why) in [
        (vec![], "empty"),
        (vec![300, 0], "zero cap"),
        (vec![500, 301], "sum over budget - reserve (800)"),
        (vec![u128::MAX, 2], "sum overflows"),
        (vec![1; 9], "more than 8"),
    ] {
        assert_eq!(deposit(&mut c, OWNER, 1000, &caps(v)), 1000, "{why}");
    }
    assert_eq!(c.get_config().tasks, 0);
    assert_eq!(deposit(&mut c, OWNER, 1000, &caps(vec![500, 300])), 0, "sum exactly budget - reserve");
    assert_eq!(deposit(&mut c, OWNER, 1000, &caps(vec![1; 8])), 0, "8 caps");
    assert_eq!(task(&c, "1").caps.len(), 8);
}

#[test]
fn ft_on_transfer_refunds_when_killed() {
    let mut c = setup();
    call(OWNER);
    c.kill();
    assert_eq!(deposit(&mut c, OWNER, 1000, CREATE), 1000);
    assert_eq!(c.get_config().tasks, 1);
}

#[test]
#[should_panic(expected = "only the USDC contract")]
fn ft_on_transfer_rejects_other_tokens() {
    let mut c = setup();
    call(EVE);
    let _ = c.ft_on_transfer(acc(OWNER), U128(1000), CREATE.into());
}

// ---------- fund_subtask ----------

#[test]
#[should_panic(expected = "n is not an approved subtask")]
fn fund_beyond_caps_refused() {
    let mut c = setup();
    call(ORCH);
    let _ = c.fund_subtask("0".into(), 4);
}

#[test]
#[should_panic(expected = "n is not an approved subtask")]
fn register_beyond_caps_refused() {
    let mut c = setup();
    register(&mut c, "0", 0);
}

#[test]
#[should_panic(expected = "no key registered for this subtask")]
fn fund_without_registered_key_refused() {
    let mut c = setup();
    call(ORCH);
    let _ = c.fund_subtask("0".into(), 1);
}

#[test]
#[should_panic(expected = "only the signer")]
fn register_by_non_signer_refused() {
    let mut c = setup();
    call(ORCH);
    c.register_subtask_key("0".into(), 1, pk());
}

#[test]
#[should_panic(expected = "key already registered")]
fn register_twice_refused() {
    let mut c = setup();
    register(&mut c, "0", 1);
    register(&mut c, "0", 1);
}

#[test]
#[should_panic(expected = "subtask already exists")]
fn register_after_funding_refused() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    register(&mut c, "0", 1);
}

#[test]
#[should_panic(expected = "task is killed")]
fn register_on_killed_task_refused() {
    let mut c = setup();
    call(OWNER);
    c.kill_task("0".into());
    register(&mut c, "0", 1);
}

#[test]
#[should_panic(expected = "only the orchestrator")]
fn fund_by_non_orchestrator_refused() {
    let mut c = setup();
    register(&mut c, "0", 1);
    call(SIGNER);
    let _ = c.fund_subtask("0".into(), 1);
}

/// A leaked orchestrator key: it can neither pick the sub-account key nor fund more than the caps.
#[test]
fn leaked_orchestrator_is_bounded_by_the_caps() {
    let mut c = setup();
    let attempt = |c: &mut Contract, pred: &str, f: &dyn Fn(&mut Contract)| {
        call(pred);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(c))).is_err()
    };
    // No way to register its own key, and no subtask without a signer key.
    assert!(attempt(&mut c, ORCH, &|c| c.register_subtask_key("0".into(), 1, pk())));
    assert!(attempt(&mut c, ORCH, &|c| drop(c.fund_subtask("0".into(), 1))));
    // With signer keys registered, it funds each approved cap once, and nothing beyond them.
    for n in 1..=3 {
        fund(&mut c, "0", n);
        assert_eq!(sub(&c, "0", n).public_key, pk());
    }
    assert!(attempt(&mut c, ORCH, &|c| drop(c.fund_subtask("0".into(), 1))));
    assert!(attempt(&mut c, ORCH, &|c| drop(c.fund_subtask("0".into(), 4))));
    let t = task(&c, "0");
    assert_eq!((t.allocated, t.unallocated), (600, 200));
    check(&c, "0");
}

#[test]
fn fund_success() {
    let mut c = setup();
    register(&mut c, "0", 1);
    assert!(has_event("subtask_key_registered"));
    call(ORCH);
    let _ = c.fund_subtask("0".into(), 1);
    let r = get_created_receipts();
    assert_eq!(r[0].receiver_id, acc(&sub_account("0", 1)));
    assert!(matches!(r[0].actions[0], MockAction::CreateAccount { .. }));
    assert!(r[0].actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFullAccess { public_key, .. } if public_key.to_string() == PK)));
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Funding);
    assert_eq!((task(&c, "0").unallocated, task(&c, "0").allocated), (500, 300));

    callback(true);
    let _ = c.on_account_created("0".into(), 1, 0);
    let usdc = get_created_receipts().into_iter().find(|r| r.receiver_id == acc(USDC)).unwrap();
    let calls: Vec<_> = usdc
        .actions
        .iter()
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, attached_deposit, .. } => {
                Some((String::from_utf8(method_name.clone()).unwrap(), *attached_deposit))
            }
            _ => None,
        })
        .collect();
    assert_eq!(calls, vec![("storage_deposit".into(), STORAGE_DEPOSIT), ("ft_transfer".into(), ONE_YOCTO)]);

    callback(true);
    assert!(c.on_subtask_funded("0".into(), 1, 0));
    assert!(has_event("subtask_funded"));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.cap, s.account_exists), (SubtaskStatus::Funded, 300, true));
    check(&c, "0");
    fund(&mut c, "0", 3);
    assert_eq!(sub(&c, "0", 3).cap, 100, "exactly the approved cap");
    assert_eq!((task(&c, "0").unallocated, task(&c, "0").allocated), (400, 400));
}

#[test]
fn fund_create_failure_rolls_back() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    callback(false);
    assert!(!value(c.on_account_created("0".into(), 1, 0)));
    assert!(has_event("subtask_funding_failed"));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, false));
    assert_eq!((task(&c, "0").unallocated, task(&c, "0").allocated), (800, 0));
    check(&c, "0");
    fund(&mut c, "0", 2); // the cap went back to the pool; n = 1 stays Failed
    assert_eq!((task(&c, "0").unallocated, task(&c, "0").allocated), (600, 200));
}

#[test]
fn fund_transfer_failure_rolls_back() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    callback(true);
    let _ = c.on_account_created("0".into(), 1, 0);
    callback(false);
    assert!(!c.on_subtask_funded("0".into(), 1, 0));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, true));
    assert_eq!(task(&c, "0").unallocated, 800);
    check(&c, "0");
}

#[test]
#[should_panic(expected = "subtask already exists")]
fn fund_same_subtask_twice_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1); // still Funding: not retryable
    call(ORCH);
    let _ = c.fund_subtask("0".into(), 1);
}

/// Review finding 2: a Failed n is retried with a fresh key and account; a stale callback is refused.
#[test]
fn failed_subtask_can_be_retried() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    callback(true);
    let _ = c.on_account_created("0".into(), 1, 0);
    callback(false);
    assert!(!c.on_subtask_funded("0".into(), 1, 0)); // t0-1 exists, holds no USDC
    // The key was used up: a retry needs a new registration.
    call(ORCH);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.fund_subtask("0".into(), 1))));
    assert!(r.is_err());
    start_fund(&mut c, "0", 1);
    assert_eq!(get_created_receipts()[0].receiver_id, acc(&format!("t0-1-1.{ME}")), "new account name");
    let s = sub(&c, "0", 1);
    assert_eq!((s.attempt, s.status, s.cap, s.account_exists), (1, SubtaskStatus::Funding, 300, false));
    callback(true);
    let stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_subtask_funded("0".into(), 1, 0)));
    assert!(stale.is_err(), "a callback of attempt 0 must not touch attempt 1");
    callback(true);
    let _ = c.on_account_created("0".into(), 1, 1);
    callback(true);
    assert!(c.on_subtask_funded("0".into(), 1, 1));
    assert_eq!(task(&c, "0").subtasks, vec![1]);
    assert_eq!((task(&c, "0").allocated, task(&c, "0").unallocated), (300, 500));
    check(&c, "0");
    assert_eq!(give_back(&mut c, &format!("t0-1-1.{ME}"), "0", 1, 100), 0);
    check(&c, "0");
}

#[test]
#[should_panic(expected = "no funding attempts left")]
fn retries_are_bounded() {
    let mut c = setup();
    for attempt in 0..MAX_ATTEMPTS {
        start_fund(&mut c, "0", 1);
        callback(false);
        let _ = c.on_account_created("0".into(), 1, attempt);
    }
    check(&c, "0");
    register(&mut c, "0", 1);
}

#[test]
fn kill_between_create_and_transfer_stops_transfer() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    call(OWNER);
    c.kill_task("0".into());
    callback(true);
    assert!(!value(c.on_account_created("0".into(), 1, 0)));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, true));
    check(&c, "0");
}

#[test]
#[should_panic(expected = "sub-account id is invalid")]
fn fund_rejects_long_account_id() {
    let mut c = setup();
    call(ORCH);
    let _ = c.fund_subtask("x".repeat(60), 1);
}

// ---------- top_up ----------

#[test]
#[should_panic(expected = "amount exceeds the remaining reserve")]
fn top_up_over_reserve_refused() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    top_up(&mut c, "0", 1, 201, true);
}

#[test]
fn top_up_failure_restores_reserve() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(ORCH);
    let _ = c.top_up("0".into(), 1, U128(50));
    assert_eq!((task(&c, "0").reserve_remaining, sub(&c, "0", 1).status), (150, SubtaskStatus::ToppingUp));
    check(&c, "0");
    callback(false);
    assert!(!c.on_top_up("0".into(), 1));
    let (t, s) = (task(&c, "0"), sub(&c, "0", 1));
    assert_eq!((t.reserve_remaining, t.topped_up, s.topped_up, s.status), (200, 0, 0, SubtaskStatus::Funded));
    check(&c, "0");
    top_up(&mut c, "0", 1, 50, true);
    assert_eq!((task(&c, "0").reserve_remaining, sub(&c, "0", 1).topped_up), (150, 50));
}

#[test]
#[should_panic(expected = "subtask is not funded")]
fn top_up_requires_funded_subtask() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    top_up(&mut c, "0", 1, 10, true);
}

// ---------- returns ----------

#[test]
fn return_from_wrong_account_refunded() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    start_fund(&mut c, "0", 2);
    assert_eq!(give_back(&mut c, EVE, "0", 1, 50), 50);
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 1, 50), 50, "another subtask's account");
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 2, 50), 50, "subtask still funding");
    assert_eq!(task(&c, "0").returned, 0);
    check(&c, "0");
}

#[test]
fn return_from_right_account_credited() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 120), 0);
    assert!(has_event("returned"));
    let (t, s) = (task(&c, "0"), sub(&c, "0", 1));
    assert_eq!((t.returned, t.unallocated, s.returned, s.status), (120, 620, 120, SubtaskStatus::Returned));
    check(&c, "0");
}

// ---------- close ----------

#[test]
#[should_panic(expected = "subtask 1 has not returned its leftover")]
fn close_refused_before_returns() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(ORCH);
    let _ = c.close_task("0".into());
}

#[test]
#[should_panic(expected = "only the funder, the owner or the orchestrator")]
fn close_by_stranger_refused() {
    let mut c = setup();
    call(EVE);
    let _ = c.close_task("0".into());
}

#[test]
fn close_refunds_the_right_amount() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    fund(&mut c, "0", 2);
    top_up(&mut c, "0", 1, 50, true);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 120), 0);
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 2, 30), 0);
    // refund = budget - (caps + top-ups) + returned = 1000 - 550 + 150
    call(ORCH);
    assert!(matches!(c.close_task("0".into()), PromiseOrValue::Promise(_)));
    let t = task(&c, "0");
    assert_eq!((t.refunded, t.status), (600, TaskStatus::Closing));
    check(&c, "0");
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 5), 5, "no returns while closing");

    callback(false);
    assert!(!c.on_task_closed("0".into()));
    let t = task(&c, "0");
    assert_eq!((t.refunded, t.unallocated, t.reserve_remaining, t.status), (0, 450, 150, TaskStatus::Open));
    check(&c, "0");

    call(OWNER);
    let _ = c.close_task("0".into());
    callback(true);
    assert!(c.on_task_closed("0".into()));
    assert!(has_event("task_closed"));
    let t = task(&c, "0");
    assert_eq!((t.refunded, t.status), (600, TaskStatus::Closed));
    check(&c, "0");
}

#[test]
#[should_panic(expected = "task is already closed")]
fn close_twice_refused() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 300), 0);
    call(ORCH);
    let _ = c.close_task("0".into());
    callback(true);
    c.on_task_closed("0".into());
    call(ORCH);
    let _ = c.close_task("0".into());
}

// ---------- kill ----------

#[test]
#[should_panic(expected = "contract is killed")]
fn kill_blocks_funding() {
    let mut c = setup();
    call(OWNER);
    c.kill();
    assert!(has_event("killed"));
    start_fund(&mut c, "0", 1);
}

#[test]
#[should_panic(expected = "task is killed")]
fn kill_task_blocks_top_up() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(OWNER);
    c.kill_task("0".into());
    top_up(&mut c, "0", 1, 10, true);
}

#[test]
#[should_panic(expected = "only the owner")]
fn kill_by_orchestrator_refused() {
    let mut c = setup();
    call(ORCH);
    c.kill();
}

#[test]
fn killed_task_returns_and_owner_close_still_work() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    fund(&mut c, "0", 2);
    call(OWNER);
    c.kill();
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 100), 0);
    check(&c, "0");
    // Subtask 2 never returns: the owner closes anyway and gets back what the contract holds.
    call(OWNER);
    let _ = c.close_task("0".into());
    callback(true);
    assert!(c.on_task_closed("0".into()));
    assert_eq!(task(&c, "0").refunded, 600);
    check(&c, "0");
    // A late return lands on the closed task, which can then be closed again.
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 2, 200), 0);
    check(&c, "0");
    call(OWNER);
    let _ = c.close_task("0".into());
    callback(true);
    assert!(c.on_task_closed("0".into()));
    assert_eq!(task(&c, "0").refunded, 800);
    check(&c, "0");
}

#[test]
#[should_panic(expected = "subtask 2 has not returned its leftover")]
fn killed_task_orchestrator_close_still_needs_returns() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    fund(&mut c, "0", 2);
    call(OWNER);
    c.kill_task("0".into());
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 100), 0);
    call(ORCH);
    let _ = c.close_task("0".into());
}

#[test]
#[should_panic(expected = "only the orchestrator")]
fn set_orchestrator_rotates_key() {
    let mut c = setup();
    owner_yocto(0);
    c.set_orchestrator(acc("orch2.testnet"));
    assert_eq!(c.get_config().orchestrator, acc("orch2.testnet"));
    start_fund(&mut c, "0", 1);
}

// ---------- receipts ----------

#[test]
fn record_receipt_appends_and_pages() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(ORCH);
    assert_eq!(c.record_receipt("0".into(), 1, receipt(Some("pass"))), 0);
    assert_eq!(c.record_receipt("0".into(), 1, receipt(None)), 1);
    assert_eq!(c.record_receipt("0".into(), 1, receipt(Some("fail"))), 2);
    assert!(has_event("receipt"));
    let page = c.get_receipts("0".into(), Some(1), Some(5));
    assert_eq!(page.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(page[0].receipt.verdict, None);
    check(&c, "0");
}

#[test]
#[should_panic(expected = "agent_handle longer than 128 bytes")]
fn record_receipt_bounds_strings() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(ORCH);
    c.record_receipt("0".into(), 1, Receipt { agent_handle: "a".repeat(129), ..receipt(None) });
}

#[test]
#[should_panic(expected = "verdict must be pass, fail or null")]
fn record_receipt_checks_verdict() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(ORCH);
    c.record_receipt("0".into(), 1, receipt(Some("maybe")));
}

#[test]
#[should_panic(expected = "unknown subtask")]
fn record_receipt_needs_subtask() {
    let mut c = setup();
    call(ORCH);
    c.record_receipt("0".into(), 9, receipt(None));
}

#[test]
fn views_serialize_amounts_as_strings() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    let t = serde_json::to_value(task(&c, "0")).unwrap();
    assert_eq!((t["budget"].as_str(), t["status"].as_str()), (Some("1000"), Some("Open")));
    let s = serde_json::to_value(c.get_subtasks("0".into())).unwrap();
    assert_eq!(s[0]["cap"], "300");
    assert_eq!(s[0]["account_id"], sub_account("0", 1));
    assert_eq!(s[0]["public_key"], PK);
    assert_eq!(t["caps"], serde_json::json!(["300", "200", "100"]));
}

// ---------- NEAR balance ----------

#[test]
#[should_panic(expected = "not enough free NEAR")]
fn fund_refused_without_free_near() {
    let mut c = setup();
    register(&mut c, "0", 1);
    // Free NEAR covers the sub-account but not the storage deposit and margin.
    call_ctx(ORCH, vec![], |b| {
        b.account_balance(NearToken::from_yoctonear(STAKED + SUBACCOUNT_NEAR.as_yoctonear()));
    });
    let _ = c.fund_subtask("0".into(), 1);
}

#[test]
fn account_created_without_near_fails_funding() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    // By the callback the free NEAR is below the storage deposit: fail the funding, do not panic.
    call_ctx(ME, vec![PromiseResult::Successful(vec![])], |b| {
        b.account_balance(NearToken::from_yoctonear(STAKED + STORAGE_DEPOSIT.as_yoctonear()));
    });
    assert!(!value(c.on_account_created("0".into(), 1, 0)));
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != acc(USDC)), "no USDC call");
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, true));
    assert_eq!(task(&c, "0").unallocated, 800);
    check(&c, "0");
    call(ORCH);
    let _ = c.close_task("0".into()); // nothing left in flight
}

// ---------- re-close after late returns ----------

#[test]
fn failed_reclose_keeps_task_closed() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 100), 0);
    call(ORCH);
    let _ = c.close_task("0".into());
    callback(true);
    assert!(c.on_task_closed("0".into()));
    // A late return, then a re-close whose refund fails: the task stays Closed, not fundable.
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 50), 0);
    call(ORCH);
    let _ = c.close_task("0".into());
    callback(false);
    assert!(!c.on_task_closed("0".into()));
    let t = task(&c, "0");
    assert_eq!((t.status, t.unallocated, t.refunded), (TaskStatus::Closed, 50, 800));
    assert!(t.closing.is_none());
    check(&c, "0");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start_fund(&mut c, "0", 2)));
    assert!(r.is_err(), "fund_subtask on a closed task must be refused");
}

// ---------- owner methods need a full-access key ----------

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn set_orchestrator_needs_one_yocto() {
    let mut c = setup();
    call(OWNER);
    c.set_orchestrator(acc(EVE));
}

// ---------- resolve_stuck ----------

#[test]
fn resolve_funding_before_usdc_call() {
    let mut c = setup();
    start_fund(&mut c, "0", 1); // on_account_created never completes
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), false);
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Failed);
    assert_eq!(task(&c, "0").unallocated, 800);
    check(&c, "0");
    call(ORCH);
    let _ = c.close_task("0".into());
    assert_eq!(task(&c, "0").status, TaskStatus::Closing);
}

#[test]
#[should_panic(expected = "too early")]
fn resolve_too_early_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    owner_yocto(RESOLVE_AFTER_BLOCKS - 1);
    c.resolve_stuck("0".into(), Some(1), false);
}

#[test]
#[should_panic(expected = "no USDC was sent")]
fn resolve_arrived_before_usdc_call_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), true);
}

#[test]
#[should_panic(expected = "only the owner")]
fn resolve_by_orchestrator_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    call_ctx(ORCH, vec![], |b| {
        b.attached_deposit(ONE_YOCTO).block_height(RESOLVE_AFTER_BLOCKS);
    });
    c.resolve_stuck("0".into(), Some(1), false);
}

#[test]
fn resolve_funding_after_usdc_call() {
    let mut c = setup();
    start_fund(&mut c, "0", 1);
    callback(true);
    let _ = c.on_account_created("0".into(), 1, 0); // on_subtask_funded never completes
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), true);
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Funded);
    check(&c, "0");

    start_fund(&mut c, "0", 2);
    callback(true);
    let _ = c.on_account_created("0".into(), 2, 0);
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(2), false);
    let s = sub(&c, "0", 2);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, true));
    assert_eq!(task(&c, "0").unallocated, 500);
    check(&c, "0");
}

#[test]
fn resolve_top_up_and_close() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(ORCH);
    let _ = c.top_up("0".into(), 1, U128(50)); // on_top_up never completes
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), false);
    let (t, s) = (task(&c, "0"), sub(&c, "0", 1));
    assert_eq!((t.reserve_remaining, s.topped_up, s.pending_top_up, s.status), (200, 0, 0, SubtaskStatus::Funded));
    check(&c, "0");

    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 300), 0);
    call(ORCH);
    let _ = c.close_task("0".into()); // on_task_closed never completes
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), None, false);
    let t = task(&c, "0");
    assert_eq!((t.status, t.unallocated, t.reserve_remaining, t.refunded), (TaskStatus::Open, 800, 200, 0));
    check(&c, "0");
    call(ORCH);
    let _ = c.close_task("0".into());
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), None, true);
    assert_eq!((task(&c, "0").status, task(&c, "0").refunded), (TaskStatus::Closed, 1000));
    check(&c, "0");
}

#[test]
#[should_panic(expected = "nothing in flight")]
fn resolve_settled_subtask_refused() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), false);
}

// ---------- receipts after close ----------

#[test]
#[should_panic(expected = "task is closed and this subtask holds no funds")]
fn record_receipt_refused_on_closed_task() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 100), 0);
    call(ORCH);
    let _ = c.close_task("0".into());
    callback(true);
    c.on_task_closed("0".into());
    call(ORCH);
    c.record_receipt("0".into(), 1, receipt(None));
}

#[test]
fn record_receipt_on_closed_task_for_funded_subtask() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    call(OWNER);
    c.kill_task("0".into());
    let _ = c.close_task("0".into());
    callback(true);
    c.on_task_closed("0".into());
    // Subtask 1 still holds funds: a payment authorized before the kill can settle and be recorded.
    call(ORCH);
    assert_eq!(c.record_receipt("0".into(), 1, receipt(Some("pass"))), 0);
}

// ---------- signer ----------

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn set_signer_needs_one_yocto() {
    let mut c = setup();
    call(OWNER);
    c.set_signer(acc(EVE));
}

#[test]
fn set_signer_rotates_key() {
    let mut c = setup();
    owner_yocto(0);
    c.set_signer(acc("signer2.testnet"));
    assert_eq!(c.get_config().signer, acc("signer2.testnet"));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| register(&mut c, "0", 1))).is_err());
    call("signer2.testnet");
    c.register_subtask_key("0".into(), 1, pk());
    call(ORCH);
    let _ = c.fund_subtask("0".into(), 1);
    assert_eq!(sub(&c, "0", 1).public_key, pk());
}

/// Review finding 1: keys a leaked signer registered stop working once the owner rotates the signer.
#[test]
fn set_signer_voids_pending_keys() {
    let mut c = setup();
    const EVIL_PK: &str = "ed25519:H9k5eiU4xXS3M4z8HzKJSLaZdqGdGwBG49o7orNC4eZW";
    for n in 1..=3 {
        call(SIGNER); // the leaked signer key
        c.register_subtask_key("0".into(), n, EVIL_PK.parse().unwrap());
    }
    owner_yocto(0);
    c.set_signer(acc("signer2.testnet"));
    call(ORCH);
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.fund_subtask("0".into(), 1))));
    let msg = err.unwrap_err().downcast::<String>().unwrap();
    assert!(msg.contains("key was registered by a previous signer"), "{msg}");
    // The new signer overwrites the stale keys, once each, and funding uses its key.
    for n in 2..=3 {
        call("signer2.testnet");
        c.register_subtask_key("0".into(), n, pk());
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.register_subtask_key("0".into(), n, pk())));
        assert!(again.is_err(), "only once per signer");
        call(ORCH);
        let _ = c.fund_subtask("0".into(), n);
        assert_eq!(sub(&c, "0", n).public_key, pk());
    }
    check(&c, "0");
}

#[test]
#[should_panic(expected = "orchestrator and signer must be different accounts")]
fn signer_cannot_be_orchestrator() {
    let mut c = setup();
    owner_yocto(0);
    c.set_signer(acc(ORCH));
}

// ---------- mark_empty ----------

/// Calls mark_empty as `pred`; the panic message, or None when it sent the balance read.
fn mark_empty_err(c: &mut Contract, pred: &str, id: &str, n: u32) -> Option<String> {
    call(pred);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.mark_empty(id.into(), n))))
        .err()
        .map(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default())
}

fn assert_refused(c: &mut Contract, pred: &str, id: &str, n: u32, why: &str) {
    let err = mark_empty_err(c, pred, id, n).unwrap_or_else(|| panic!("mark_empty({id}, {n}) as {pred} went through"));
    assert!(err.contains(why), "expected {why:?}, got {err:?}");
}

/// on_mark_empty with the USDC `ft_balance_of` result: Some(json) succeeded, None failed.
fn on_balance(c: &mut Contract, id: &str, n: u32, result: Option<&str>) -> bool {
    let (attempt, since) = (sub(c, id, n).attempt, sub(c, id, n).since);
    call_with(ME, vec![result.map_or(PromiseResult::Failed, |r| PromiseResult::Successful(r.as_bytes().to_vec()))]);
    c.on_mark_empty(id.into(), n, attempt, since)
}

#[test]
fn mark_empty_refused_unless_funded() {
    let mut c = setup();
    let not_funded = "subtask is not funded";
    assert_refused(&mut c, ORCH, "0", 1, "unknown subtask");
    assert_refused(&mut c, ORCH, "9", 1, "unknown task");
    start_fund(&mut c, "0", 1);
    assert_refused(&mut c, ORCH, "0", 1, not_funded); // Funding
    callback(true);
    let _ = c.on_account_created("0".into(), 1, 0);
    callback(true);
    c.on_subtask_funded("0".into(), 1, 0);
    call(ORCH);
    let _ = c.top_up("0".into(), 1, U128(10));
    assert_refused(&mut c, ORCH, "0", 1, not_funded); // ToppingUp
    callback(true);
    c.on_top_up("0".into(), 1);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 10), 0);
    assert_refused(&mut c, ORCH, "0", 1, not_funded); // Returned
    start_fund(&mut c, "0", 2);
    callback(false);
    let _ = c.on_account_created("0".into(), 2, 0);
    assert_refused(&mut c, ORCH, "0", 2, not_funded); // Failed
    check(&c, "0");
}

#[test]
fn mark_empty_caller_and_task_status() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    let only = "only the funder, the owner or the orchestrator";
    assert_refused(&mut c, SIGNER, "0", 1, only);
    assert_refused(&mut c, EVE, "0", 1, only);
    assert_eq!(mark_empty_err(&mut c, OWNER, "0", 1), None, "the owner may");
    assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None, "the orchestrator may");
    let r = get_created_receipts();
    assert_eq!(r[0].receiver_id, acc(USDC));
    assert!(matches!(&r[0].actions[0], MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. }
        if method_name == b"ft_balance_of" && String::from_utf8_lossy(args).contains(&sub_account("0", 1)) && attached_deposit.is_zero()));
    // A killed task is still Open: allowed. The owner closes it with subtask 1 Funded: Closing, then Closed.
    call(OWNER);
    c.kill_task("0".into());
    assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None, "killed task");
    call(OWNER);
    let _ = c.close_task("0".into());
    assert_refused(&mut c, ORCH, "0", 1, "task is closing"); // Closing
    assert!(!on_balance(&mut c, "0", 1, Some(r#""0""#)), "a read that lands while the refund is in flight does not mark");
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Funded);
    callback(true);
    assert!(c.on_task_closed("0".into()));
    assert_eq!(mark_empty_err(&mut c, OWNER, "0", 1), None, "a Closed task may still mark an emptied sub-account");
    check(&c, "0");
}

#[test]
fn mark_empty_zero_balance_lets_close_succeed() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    fund(&mut c, "0", 2);
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 2, 50), 0);
    // Subtask 1 paid its whole cap: no return can ever come, so close_task is stuck without mark_empty.
    call(ORCH);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.close_task("0".into())))).is_err());
    assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None);
    assert!(on_balance(&mut c, "0", 1, Some(r#""0""#)));
    let log = get_logs().into_iter().find(|l| l.contains(r#""event":"returned""#)).unwrap();
    assert!(log.contains(r#""amount":"0""#) && log.contains(r#""empty":true"#), "{log}");
    let (t, s) = (task(&c, "0"), sub(&c, "0", 1));
    assert_eq!((s.status, s.returned, t.returned, t.unallocated), (SubtaskStatus::Returned, 0, 50, 350));
    check(&c, "0");
    call(ORCH);
    assert!(matches!(c.close_task("0".into()), PromiseOrValue::Promise(_)));
    callback(true);
    assert!(c.on_task_closed("0".into()));
    let t = task(&c, "0");
    assert_eq!((t.status, t.refunded), (TaskStatus::Closed, 550), "1000 - 300 - 200 + 50 returned");
    check(&c, "0");
    // A return that still arrives later is credited, and the task can be closed again.
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 7), 0);
    check(&c, "0");
}

#[test]
fn mark_empty_nonzero_or_failed_read_changes_nothing() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    let before = serde_json::to_string(&(task(&c, "0"), sub(&c, "0", 1))).unwrap();
    for result in [Some(r#""1""#), Some(r#""300""#), None, Some("not json"), Some("0")] {
        assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None);
        assert!(!on_balance(&mut c, "0", 1, result), "{result:?}");
        assert!(!has_event("returned"));
        assert_eq!(serde_json::to_string(&(task(&c, "0"), sub(&c, "0", 1))).unwrap(), before, "{result:?}");
    }
    check(&c, "0");
}

#[test]
fn mark_empty_stale_callbacks_change_nothing() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    // A top-up starts and lands between the balance read and the callback: the 0 is stale.
    let (attempt, since) = (sub(&c, "0", 1).attempt, sub(&c, "0", 1).since);
    assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None);
    call_ctx(ORCH, vec![], |b| {
        b.block_height(5);
    });
    let _ = c.top_up("0".into(), 1, U128(10));
    callback(true);
    c.on_top_up("0".into(), 1);
    call_with(ME, vec![PromiseResult::Successful(br#""0""#.to_vec())]);
    assert!(!c.on_mark_empty("0".into(), 1, attempt, since));
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Funded);
    // A return lands between the read and the callback: credited once, not overwritten.
    assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 40), 0);
    assert!(!on_balance(&mut c, "0", 1, Some(r#""0""#)));
    assert_eq!((sub(&c, "0", 1).returned, task(&c, "0").returned), (40, 40));
    check(&c, "0");
    // A callback for another funding attempt is refused, like the funding callbacks.
    callback(true);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_mark_empty("0".into(), 1, 1, since)));
    assert!(r.is_err(), "attempt 1 does not exist");
}

// ---------- open funding ----------

const ALICE: &str = "alice.testnet";

fn open_tasks(c: &Contract, who: &str) -> u32 {
    c.get_open_tasks(acc(who))
}

fn close_ok(c: &mut Contract, pred: &str, id: &str) {
    call(pred);
    let _ = c.close_task(id.into());
    callback(true);
    assert!(c.on_task_closed(id.into()));
}

#[test]
fn any_account_funds_its_own_task() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    let t = task(&c, "0");
    assert_eq!((t.funder, t.budget), (acc(ALICE), 1000));
    assert!(get_logs()[0].contains(r#""funder":"alice.testnet""#));
    assert_eq!((open_tasks(&c, ALICE), open_tasks(&c, OWNER)), (1, 0));
    // The orchestrator funds it like any other task; the refund on close goes to Alice.
    fund(&mut c, "0", 1);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 100), 0);
    call(ORCH);
    let _ = c.close_task("0".into());
    let r = get_created_receipts();
    assert!(matches!(&r[0].actions[0], MockAction::FunctionCallWeight { method_name, args, .. }
        if method_name == b"ft_transfer" && String::from_utf8_lossy(args).contains(ALICE) && String::from_utf8_lossy(args).contains(r#""amount":"800""#)));
    callback(true);
    assert!(c.on_task_closed("0".into()));
    assert_eq!(task(&c, "0").status, TaskStatus::Closed, "a task with a funded subtask is kept");
    assert_eq!(open_tasks(&c, ALICE), 0);
    check(&c, "0");
}

#[test]
fn budget_below_minimum_refunded() {
    let mut c = default_contract();
    let caps = r#"{"create_task":{"reserve_bps":2000,"caps":["500000"]}}"#;
    assert_eq!(deposit(&mut c, ALICE, 999_999, caps), 999_999);
    assert_eq!(c.get_config().tasks, 0);
    assert_eq!(deposit(&mut c, ALICE, 1_000_000, caps), 0, "exactly 1 USDC");
    let cfg = c.get_config();
    assert_eq!((cfg.min_budget, cfg.max_open_tasks), (U128(DEFAULT_MIN_BUDGET), DEFAULT_MAX_OPEN_TASKS));
}

#[test]
fn open_tasks_per_funder_are_limited() {
    let mut c = new_contract();
    for i in 0..DEFAULT_MAX_OPEN_TASKS {
        assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0, "task {i}");
    }
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 1000, "one over the limit");
    assert_eq!(deposit(&mut c, EVE, 1000, CREATE), 0, "another funder is not affected");
    // A failed refund keeps the task open and counted.
    call(ALICE);
    let _ = c.close_task("0".into());
    callback(false);
    assert!(!c.on_task_closed("0".into()));
    assert_eq!((task(&c, "0").status, open_tasks(&c, ALICE)), (TaskStatus::Open, 5));
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 1000);
    close_ok(&mut c, ALICE, "0");
    assert_eq!(open_tasks(&c, ALICE), 4);
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0, "a closed task frees its slot");
}

#[test]
fn close_with_nothing_funded_deletes_the_task() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    register(&mut c, "0", 1); // a key registered but never used is dropped too
    close_ok(&mut c, ALICE, "0");
    let log = get_logs().into_iter().find(|l| l.contains(r#""event":"task_closed""#)).unwrap();
    assert!(log.contains(r#""deleted":true"#) && log.contains(r#""refund":"1000""#), "{log}");
    assert!(c.get_task("0".into()).is_none());
    assert!(c.keys.get(&("0".to_string(), 1)).is_none());
    assert_eq!((open_tasks(&c, ALICE), c.get_config().tasks), (0, 1));
    assert!(c.open_tasks.get(&acc(ALICE)).is_none(), "the counter entry is removed at 0");
    // Ids are never reused.
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    assert!(c.get_task("1".into()).is_some());
}

#[test]
fn funder_kills_and_closes_its_task() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    fund(&mut c, "0", 1);
    fund(&mut c, "0", 2);
    assert_eq!(give_back(&mut c, &sub_account("0", 1), "0", 1, 100), 0);
    call(ALICE);
    c.kill_task("0".into());
    assert!(task(&c, "0").killed);
    // Subtask 2 never returns; Alice closes anyway and gets back what the contract holds.
    close_ok(&mut c, ALICE, "0");
    assert_eq!((task(&c, "0").refunded, open_tasks(&c, ALICE)), (600, 0));
    // A late return, then a second close, does not count the task twice.
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 2, 200), 0);
    close_ok(&mut c, ALICE, "0");
    assert_eq!((task(&c, "0").refunded, open_tasks(&c, ALICE)), (800, 0));
    check(&c, "0");
}

#[test]
#[should_panic(expected = "only the owner or the task's funder")]
fn kill_task_by_stranger_refused() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    call(EVE);
    c.kill_task("0".into());
}

#[test]
#[should_panic(expected = "only the owner or the task's funder")]
fn kill_task_by_orchestrator_refused() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    call(ORCH);
    c.kill_task("0".into());
}

#[test]
#[should_panic(expected = "only the funder, the owner or the orchestrator")]
fn other_funder_cannot_close() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    assert_eq!(deposit(&mut c, EVE, 1000, CREATE), 0);
    call(EVE);
    let _ = c.close_task("0".into());
}

#[test]
fn funder_may_mark_empty() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    fund(&mut c, "0", 1);
    assert_eq!(mark_empty_err(&mut c, ALICE, "0", 1), None);
    assert_refused(&mut c, EVE, "0", 1, "only the funder, the owner or the orchestrator");
}

#[test]
fn subtask_account_cannot_fund_tasks() {
    let mut c = setup();
    fund(&mut c, "0", 1);
    assert_eq!(deposit(&mut c, &sub_account("0", 1), 300, CREATE), 300);
    assert_eq!(c.get_config().tasks, 1);
}

#[test]
fn set_limits_by_owner_only() {
    let mut c = default_contract();
    owner_yocto(0);
    c.set_limits(U128(5), 2);
    let cfg = c.get_config();
    assert_eq!((cfg.min_budget, cfg.max_open_tasks), (U128(5), 2));
    for (pred, yocto, args, why) in [
        (EVE, true, (5u128, 2u32), "only the owner"),
        (ORCH, true, (5, 2), "only the owner"),
        (OWNER, false, (5, 2), "Requires attached deposit of exactly 1 yoctoNEAR"),
        (OWNER, true, (0, 2), "limits must be positive"),
        (OWNER, true, (5, 0), "limits must be positive"),
    ] {
        call_ctx(pred, vec![], |b| {
            if yocto {
                b.attached_deposit(ONE_YOCTO);
            }
        });
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_limits(U128(args.0), args.1)));
        let err = r.err().map(|e| e.downcast::<String>().map(|s| *s).unwrap_or_default()).unwrap_or_default();
        assert!(err.contains(why), "{pred} {args:?}: expected {why:?}, got {err:?}");
    }
}

// ---------- review fixes (2026-11-09) ----------

#[test]
fn funder_closes_killed_task_then_spent_subtask_is_marked_empty() {
    let mut c = new_contract();
    assert_eq!(deposit(&mut c, ALICE, 1000, CREATE), 0);
    fund(&mut c, "0", 1);
    call(ALICE);
    c.kill_task("0".into());
    close_ok(&mut c, ALICE, "0"); // subtask 1 still Funded: its hire is being paid
    assert_eq!(task(&c, "0").status, TaskStatus::Closed);
    // The payment settles and empties the sub-account: the orchestrator marks it on the Closed task.
    assert_eq!(mark_empty_err(&mut c, ORCH, "0", 1), None);
    assert!(on_balance(&mut c, "0", 1, Some(r#""0""#)));
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Returned);
    check(&c, "0");
    // Nothing more to refund, so a further close is refused rather than sending 0.
    call(ORCH);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.close_task("0".into()))));
    assert!(r.is_err());
}

#[test]
fn create_task_refunded_when_contract_is_short_of_near() {
    let mut c = new_contract();
    call_ctx(USDC, vec![], |b| {
        b.account_balance(NearToken::from_yoctonear(STAKED + NEW_TASK_FLOOR.as_yoctonear() - 1));
    });
    assert_eq!(value(c.ft_on_transfer(acc(ALICE), U128(1000), CREATE.into())).0, 1000);
    assert!(get_logs().iter().any(|l| l.contains("short of NEAR")));
    assert_eq!(c.get_config().tasks, 0);
    call_ctx(USDC, vec![], |b| {
        b.account_balance(NearToken::from_yoctonear(STAKED + NEW_TASK_FLOOR.as_yoctonear()));
    });
    assert_eq!(value(c.ft_on_transfer(acc(ALICE), U128(1000), CREATE.into())).0, 0);
}
