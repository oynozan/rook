use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const OWNER: &str = "owner.testnet";
const ORCH: &str = "orch.testnet";
const USDC: &str = "usdc.testnet";
const ME: &str = "rook.testnet";
const EVE: &str = "eve.testnet";
const CREATE: &str = r#"{"create_task":{"reserve_bps":2000}}"#;

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

fn pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
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

/// Contract with task "0": budget 1000, reserve 200, unallocated 800.
fn setup() -> Contract {
    call(OWNER);
    let mut c = Contract::new(acc(OWNER), acc(ORCH), acc(USDC));
    assert_eq!(deposit(&mut c, OWNER, 1000, CREATE), 0);
    check(&c, "0");
    c
}

fn start_fund(c: &mut Contract, id: &str, n: u32, cap: u128) {
    call(ORCH);
    let _ = c.fund_subtask(id.into(), n, U128(cap), pk());
    check(c, id);
}

fn fund(c: &mut Contract, id: &str, n: u32, cap: u128) {
    start_fund(c, id, n, cap);
    callback(true);
    let _ = c.on_account_created(id.into(), n);
    check(c, id);
    callback(true);
    assert!(c.on_subtask_funded(id.into(), n));
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
    assert_eq!(deposit(&mut c, OWNER, 10, CREATE), 0);
    assert!(c.get_task("1".into()).is_some());
    assert_eq!((base36(35).as_str(), base36(36).as_str()), ("z", "10"));
}

#[test]
fn ft_on_transfer_refunds_bad_messages() {
    call(OWNER);
    let mut c = Contract::new(acc(OWNER), acc(ORCH), acc(USDC));
    for msg in ["", "nope", r#"{"foo":{}}"#, r#"{"create_task":{"reserve_bps":9001}}"#, r#"{"create_task":{}}"#] {
        assert_eq!(deposit(&mut c, OWNER, 1000, msg), 1000, "msg {msg}");
    }
    assert_eq!(deposit(&mut c, EVE, 1000, CREATE), 1000, "only the owner funds tasks");
    assert_eq!(c.get_config().tasks, 0);
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
#[should_panic(expected = "cap exceeds the unallocated budget")]
fn fund_over_unallocated_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 801);
}

#[test]
#[should_panic(expected = "only the orchestrator")]
fn fund_by_non_orchestrator_refused() {
    let mut c = setup();
    call(OWNER);
    let _ = c.fund_subtask("0".into(), 1, U128(100), pk());
}

#[test]
fn fund_success() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    let r = get_created_receipts();
    assert_eq!(r[0].receiver_id, acc(&sub_account("0", 1)));
    assert!(matches!(r[0].actions[0], MockAction::CreateAccount { .. }));
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Funding);
    assert_eq!((task(&c, "0").unallocated, task(&c, "0").allocated), (500, 300));

    callback(true);
    let _ = c.on_account_created("0".into(), 1);
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
    assert!(c.on_subtask_funded("0".into(), 1));
    assert!(has_event("subtask_funded"));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.cap, s.account_exists), (SubtaskStatus::Funded, 300, true));
    check(&c, "0");
}

#[test]
fn fund_create_failure_rolls_back() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    callback(false);
    assert!(!value(c.on_account_created("0".into(), 1)));
    assert!(has_event("subtask_funding_failed"));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, false));
    assert_eq!((task(&c, "0").unallocated, task(&c, "0").allocated), (800, 0));
    check(&c, "0");
    fund(&mut c, "0", 2, 800); // the full allocation is available again
}

#[test]
fn fund_transfer_failure_rolls_back() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    callback(true);
    let _ = c.on_account_created("0".into(), 1);
    callback(false);
    assert!(!c.on_subtask_funded("0".into(), 1));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, true));
    assert_eq!(task(&c, "0").unallocated, 800);
    check(&c, "0");
}

#[test]
#[should_panic(expected = "subtask already exists")]
fn fund_same_subtask_twice_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    callback(false);
    let _ = c.on_account_created("0".into(), 1);
    start_fund(&mut c, "0", 1, 300);
}

#[test]
fn kill_between_create_and_transfer_stops_transfer() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    call(OWNER);
    c.kill_task("0".into());
    callback(true);
    assert!(!value(c.on_account_created("0".into(), 1)));
    let s = sub(&c, "0", 1);
    assert_eq!((s.status, s.account_exists), (SubtaskStatus::Failed, true));
    check(&c, "0");
}

#[test]
#[should_panic(expected = "sub-account id is invalid")]
fn fund_rejects_long_account_id() {
    let mut c = setup();
    call(ORCH);
    let _ = c.fund_subtask("x".repeat(60), 1, U128(1), pk());
}

// ---------- top_up ----------

#[test]
#[should_panic(expected = "amount exceeds the remaining reserve")]
fn top_up_over_reserve_refused() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
    top_up(&mut c, "0", 1, 201, true);
}

#[test]
fn top_up_failure_restores_reserve() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
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
    start_fund(&mut c, "0", 1, 300);
    top_up(&mut c, "0", 1, 10, true);
}

// ---------- returns ----------

#[test]
fn return_from_wrong_account_refunded() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
    start_fund(&mut c, "0", 2, 100);
    assert_eq!(give_back(&mut c, EVE, "0", 1, 50), 50);
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 1, 50), 50, "another subtask's account");
    assert_eq!(give_back(&mut c, &sub_account("0", 2), "0", 2, 50), 50, "subtask still funding");
    assert_eq!(task(&c, "0").returned, 0);
    check(&c, "0");
}

#[test]
fn return_from_right_account_credited() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
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
    fund(&mut c, "0", 1, 300);
    call(ORCH);
    let _ = c.close_task("0".into());
}

#[test]
#[should_panic(expected = "only the owner or orchestrator")]
fn close_by_stranger_refused() {
    let mut c = setup();
    call(EVE);
    let _ = c.close_task("0".into());
}

#[test]
fn close_refunds_the_right_amount() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
    fund(&mut c, "0", 2, 200);
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
    start_fund(&mut c, "0", 1, 100);
}

#[test]
#[should_panic(expected = "task is killed")]
fn kill_task_blocks_top_up() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
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
    fund(&mut c, "0", 1, 300);
    fund(&mut c, "0", 2, 200);
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
    fund(&mut c, "0", 1, 300);
    fund(&mut c, "0", 2, 200);
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
    start_fund(&mut c, "0", 1, 100);
}

// ---------- receipts ----------

#[test]
fn record_receipt_appends_and_pages() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
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
    fund(&mut c, "0", 1, 300);
    call(ORCH);
    c.record_receipt("0".into(), 1, Receipt { agent_handle: "a".repeat(129), ..receipt(None) });
}

#[test]
#[should_panic(expected = "verdict must be pass, fail or null")]
fn record_receipt_checks_verdict() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
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
    fund(&mut c, "0", 1, 300);
    let t = serde_json::to_value(task(&c, "0")).unwrap();
    assert_eq!((t["budget"].as_str(), t["status"].as_str()), (Some("1000"), Some("Open")));
    let s = serde_json::to_value(c.get_subtasks("0".into())).unwrap();
    assert_eq!(s[0]["cap"], "300");
    assert_eq!(s[0]["account_id"], sub_account("0", 1));
}

// ---------- NEAR balance ----------

#[test]
#[should_panic(expected = "not enough free NEAR")]
fn fund_refused_without_free_near() {
    let mut c = setup();
    // Free NEAR covers the sub-account but not the storage deposit and margin.
    call_ctx(ORCH, vec![], |b| {
        b.account_balance(NearToken::from_yoctonear(STAKED + SUBACCOUNT_NEAR.as_yoctonear()));
    });
    let _ = c.fund_subtask("0".into(), 1, U128(100), pk());
}

#[test]
fn account_created_without_near_fails_funding() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    // By the callback the free NEAR is below the storage deposit: fail the funding, do not panic.
    call_ctx(ME, vec![PromiseResult::Successful(vec![])], |b| {
        b.account_balance(NearToken::from_yoctonear(STAKED + STORAGE_DEPOSIT.as_yoctonear()));
    });
    assert!(!value(c.on_account_created("0".into(), 1)));
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
    fund(&mut c, "0", 1, 300);
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
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start_fund(&mut c, "0", 2, 50)));
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
    start_fund(&mut c, "0", 1, 300); // on_account_created never completes
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
    start_fund(&mut c, "0", 1, 300);
    owner_yocto(RESOLVE_AFTER_BLOCKS - 1);
    c.resolve_stuck("0".into(), Some(1), false);
}

#[test]
#[should_panic(expected = "no USDC was sent")]
fn resolve_arrived_before_usdc_call_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), true);
}

#[test]
#[should_panic(expected = "only the owner")]
fn resolve_by_orchestrator_refused() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    call_ctx(ORCH, vec![], |b| {
        b.attached_deposit(ONE_YOCTO).block_height(RESOLVE_AFTER_BLOCKS);
    });
    c.resolve_stuck("0".into(), Some(1), false);
}

#[test]
fn resolve_funding_after_usdc_call() {
    let mut c = setup();
    start_fund(&mut c, "0", 1, 300);
    callback(true);
    let _ = c.on_account_created("0".into(), 1); // on_subtask_funded never completes
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), true);
    assert_eq!(sub(&c, "0", 1).status, SubtaskStatus::Funded);
    check(&c, "0");

    start_fund(&mut c, "0", 2, 100);
    callback(true);
    let _ = c.on_account_created("0".into(), 2);
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
    fund(&mut c, "0", 1, 300);
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
    fund(&mut c, "0", 1, 300);
    owner_yocto(RESOLVE_AFTER_BLOCKS);
    c.resolve_stuck("0".into(), Some(1), false);
}

// ---------- receipts after close ----------

#[test]
#[should_panic(expected = "task is closed and this subtask holds no funds")]
fn record_receipt_refused_on_closed_task() {
    let mut c = setup();
    fund(&mut c, "0", 1, 300);
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
    fund(&mut c, "0", 1, 300);
    call(OWNER);
    c.kill_task("0".into());
    let _ = c.close_task("0".into());
    callback(true);
    c.on_task_closed("0".into());
    // Subtask 1 still holds funds: a payment authorized before the kill can settle and be recorded.
    call(ORCH);
    assert_eq!(c.record_receipt("0".into(), 1, receipt(Some("pass"))), 0);
}
