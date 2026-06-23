//! Mirror of the most critical `test/AgentSkillRegistry.t.sol` invariants. Names are
//! Rust-cased twins of the Foundry tests so a reviewer can grep both files side by side.

use super::*;
use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::U512;
use odra::host::{Deployer, HostEnv, HostRef};

const PRICE: u64 = 1_000_000; // motes, arbitrary — only price/escrow equality matters
const DEADLINE_MS: u64 = 24 * 60 * 60 * 1_000; // 1 day

fn setup() -> (HostEnv, AgentSkillRegistryHostRef, Address, Address) {
    let env = odra_test::env();
    let init_args = AgentSkillRegistryInitArgs {
        review_window_ms: DEFAULT_REVIEW_WINDOW,
    };
    let contract = AgentSkillRegistry::deploy(&env, init_args);
    let alpha = env.get_account(1); // provider (skill owner)
    let beta = env.get_account(2); // requester
    (env, contract, alpha, beta)
}

fn task_hash(label: &str) -> Bytes {
    Bytes::from(label.as_bytes().to_vec())
}

fn register_skill(env: &HostEnv, contract: &mut AgentSkillRegistryHostRef, alpha: Address) -> u64 {
    env.set_caller(alpha);
    contract.register_skill(
        "search".to_string(),
        "paid discover_skills".to_string(),
        "mcp://alpha".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_NONE,
    )
}

fn register_gated_skill(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    alpha: Address,
    min_rep: u32,
) -> u64 {
    env.set_caller(alpha);
    contract.register_skill(
        "premium".to_string(),
        "institutional".to_string(),
        "mcp://alpha".to_string(),
        U512::from(PRICE),
        min_rep,
        IDENTITY_POLICY_NONE,
    )
}

fn open_job(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    beta: Address,
    skill_id: u64,
    label: &str,
) -> u64 {
    env.set_caller(beta);
    contract
        .with_tokens(U512::from(PRICE))
        .create_job(skill_id, task_hash(label), DEADLINE_MS)
}

// ── Happy path ─────────────────────────────────────────────
#[test]
fn happy_path_escrow_flow_and_reputation() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-params");

    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("result-data"));

    env.set_caller(beta);
    reg.confirm_completion(job_id);

    let bal_before = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before + U512::from(PRICE));

    let s = reg.get_skill(skill_id);
    assert_eq!(s.reputation_score, 55, "skill reputation +5 from base 50");
    assert_eq!(s.total_invocations, 1);
    assert_eq!(reg.agent_reputation(alpha), 55, "provider agent rep +5");
    assert_eq!(reg.agent_reputation(beta), 55, "requester agent rep +5");
}

#[test]
fn create_job_requires_exact_escrow() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(U512::from(PRICE - 1))
            .try_create_job(skill_id, task_hash("t"), DEADLINE_MS),
        Err(Error::EscrowMustEqualPrice.into())
    );
}

// ── Open-state refund (Solidity FM1: must remain intact after `deadline` is repurposed) ──
#[test]
fn refund_after_deadline() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-1");

    env.advance_block_time(DEADLINE_MS + 1);
    env.set_caller(beta);
    reg.claim_refund(job_id);

    let bal_before = env.balance_of(&beta);
    env.set_caller(beta);
    reg.withdraw();
    assert_eq!(env.balance_of(&beta), bal_before + U512::from(PRICE));
}

#[test]
fn refund_at_exact_deadline_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-1");

    env.advance_block_time(DEADLINE_MS); // == deadline, not strictly past
    env.set_caller(beta);
    assert_eq!(reg.try_claim_refund(job_id), Err(Error::BeforeDeadline.into()));
}

#[test]
fn refund_after_delivered_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-1");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEADLINE_MS + 1);
    env.set_caller(beta);
    assert_eq!(reg.try_claim_refund(job_id), Err(Error::NotRefundable.into()));
}

// ── Claim 3 (no permanent fund lock): delivered + ghost requester → provider claims after window ──
#[test]
fn delivered_ghost_requester_provider_claims_after_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(alpha);
    reg.claim_after_review(job_id);

    let bal_before = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before + U512::from(PRICE));
    assert_eq!(reg.agent_reputation(alpha), 55, "claim_after_review bumps arm's-length rep");
}

#[test]
fn delivered_junk_result_requester_disputes_within_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.set_caller(beta);
    reg.dispute_result(job_id);

    let bal_before = env.balance_of(&beta);
    env.set_caller(beta);
    reg.withdraw();
    assert_eq!(env.balance_of(&beta), bal_before + U512::from(PRICE), "requester refunded on dispute");
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION, "dispute grants no provider rep");
}

#[test]
fn dispute_after_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(beta);
    assert_eq!(reg.try_dispute_result(job_id), Err(Error::ReviewWindowClosed.into()));
}

#[test]
fn claim_at_exact_window_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW); // == deadline, not strictly past
    env.set_caller(alpha);
    assert_eq!(reg.try_claim_after_review(job_id), Err(Error::ReviewWindowOpen.into()));
}

#[test]
fn confirm_completion_still_works_after_window() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));

    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 100);
    env.set_caller(beta);
    reg.confirm_completion(job_id);
    assert_eq!(reg.agent_reputation(alpha), 55, "late confirm still settles");
}

#[test]
fn double_complete_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "t");
    env.set_caller(alpha);
    reg.deliver_result(job_id, task_hash("r"));
    env.set_caller(beta);
    reg.confirm_completion(job_id);

    env.set_caller(beta);
    assert_eq!(reg.try_confirm_completion(job_id), Err(Error::JobNotDelivered.into()));
}

// ── Trust Gate (PD-005) ──
#[test]
fn gate_bootstrap_base_50() {
    let (env, reg, _, _) = setup();
    let fresh = env.get_account(7);
    assert_eq!(reg.agent_reputation(fresh), BASE_REPUTATION);
}

#[test]
fn gate_blocks_under_rep_requester() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_gated_skill(&env, &mut reg, alpha, 55);
    env.set_caller(beta); // fresh rep 50
    assert_eq!(
        reg.with_tokens(U512::from(PRICE))
            .try_create_job(skill_id, task_hash("t"), DEADLINE_MS),
        Err(Error::InsufficientReputation.into())
    );
}

#[test]
fn set_min_reputation_owner_only() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(reg.try_set_min_reputation(skill_id, 70), Err(Error::NotSkillOwner.into()));

    env.set_caller(alpha);
    reg.set_min_reputation(skill_id, 70);
    assert_eq!(reg.get_skill(skill_id).min_reputation_to_invoke, 70);
}

// ── P0: identity policy is declarative; owner-only ──
#[test]
fn identity_policy_defaults_to_none_and_owner_can_set() {
    let (env, mut reg, alpha, _) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    assert_eq!(reg.get_skill(skill_id).identity_policy, IDENTITY_POLICY_NONE);

    env.set_caller(alpha);
    reg.set_identity_policy(skill_id, IDENTITY_POLICY_T3N);
    assert_eq!(reg.get_skill(skill_id).identity_policy, IDENTITY_POLICY_T3N);
}

#[test]
fn set_identity_policy_owner_only() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    env.set_caller(beta);
    assert_eq!(
        reg.try_set_identity_policy(skill_id, IDENTITY_POLICY_T3N),
        Err(Error::NotSkillOwner.into())
    );
}

#[test]
fn register_skill_persists_identity_policy() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    let skill_id = reg.register_skill(
        "s".to_string(),
        "d".to_string(),
        "mcp://a".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_T3N_FRESH,
    );
    assert_eq!(reg.get_skill(skill_id).identity_policy, IDENTITY_POLICY_T3N_FRESH);
}

// ── Self-deal nullification (Solidity audit Abductive-2 + Tier-0) ──
#[test]
fn self_deal_no_rep_farm() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    let skill_id = reg.register_skill(
        "self".to_string(),
        "self".to_string(),
        "mcp://alpha".to_string(),
        U512::from(PRICE),
        0,
        IDENTITY_POLICY_NONE,
    );

    // Path 1: confirm_completion on a self-job.
    env.set_caller(alpha);
    let j1 = reg
        .with_tokens(U512::from(PRICE))
        .create_job(skill_id, task_hash("self-1"), DEADLINE_MS);
    env.set_caller(alpha);
    reg.deliver_result(j1, task_hash("r"));
    env.set_caller(alpha);
    reg.confirm_completion(j1);
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION, "self-deal confirm grants no agent rep");

    // Path 2: claim_after_review on a self-job.
    env.set_caller(alpha);
    let j2 = reg
        .with_tokens(U512::from(PRICE))
        .create_job(skill_id, task_hash("self-2"), DEADLINE_MS);
    env.set_caller(alpha);
    reg.deliver_result(j2, task_hash("r"));
    env.advance_block_time(DEFAULT_REVIEW_WINDOW + 1);
    env.set_caller(alpha);
    reg.claim_after_review(j2);
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION, "self-deal claim grants no agent rep");

    let s = reg.get_skill(skill_id);
    assert_eq!(s.reputation_score, BASE_REPUTATION, "self-deal must not inflate BM25 boost input");
    assert_eq!(s.total_invocations, 0, "self-deal must not inflate invocation count");
}

// ── PD-003: O(1) dedup index ──
#[test]
fn job_by_task_hash_dedup_index() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let job_id = open_job(&env, &mut reg, beta, skill_id, "task-params");
    assert_eq!(reg.job_id_for_task_hash(task_hash("task-params")), job_id);
    assert_eq!(reg.job_id_for_task_hash(task_hash("never")), 0);
}

// ── Fix 5: durable exactly-once ──
#[test]
fn create_job_duplicate_task_hash_reverts() {
    let (env, mut reg, alpha, beta) = setup();
    let skill_id = register_skill(&env, &mut reg, alpha);
    let _job_id = open_job(&env, &mut reg, beta, skill_id, "task-params");

    env.set_caller(beta);
    assert_eq!(
        reg.with_tokens(U512::from(PRICE))
            .try_create_job(skill_id, task_hash("task-params"), DEADLINE_MS),
        Err(Error::DuplicateTaskHash.into())
    );
    // Exactly-one escrow held — registry balance equals one PRICE.
    assert_eq!(env.balance_of(&reg), U512::from(PRICE));
}

// ── Constructor bounds (immutable review window) ──
#[test]
fn constructor_default_window() {
    let (_, reg, _, _) = setup();
    assert_eq!(reg.review_window(), DEFAULT_REVIEW_WINDOW);
}

#[test]
fn constructor_rejects_below_min() {
    let env = odra_test::env();
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: MIN_REVIEW_WINDOW - 1,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::BadReviewWindow.into())
    );
}

#[test]
fn constructor_rejects_above_max() {
    let env = odra_test::env();
    let bad = AgentSkillRegistryInitArgs {
        review_window_ms: MAX_REVIEW_WINDOW + 1,
    };
    assert_eq!(
        AgentSkillRegistry::try_deploy(&env, bad).err(),
        Some(Error::BadReviewWindow.into())
    );
}

// ── Tier-2 Sybil-resistance bond (PD-007) ──
const BOND: u64 = 2_000_000;

#[test]
fn bond_deposit_seeds_and_is_per_agent() {
    let (env, reg, alpha, beta) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();

    assert_eq!(reg.bonded_of(alpha), U512::from(BOND), "bond locked");
    assert_eq!(reg.seed_eligible_bond(alpha), U512::from(BOND), "active bond seeds");
    assert_eq!(reg.bonded_of(beta), U512::zero(), "per-agent: alpha's does not seed beta");
    assert_eq!(reg.seed_eligible_bond(beta), U512::zero());

    assert!(env.emitted_event(
        &reg,
        BondUpdated {
            agent: alpha,
            bonded_amount: U512::from(BOND),
            seed_eligible: U512::from(BOND),
        }
    ));
}

#[test]
fn bond_deposit_zero_reverts() {
    let (env, reg, alpha, _) = setup();
    env.set_caller(alpha);
    assert_eq!(
        reg.with_tokens(U512::zero()).try_deposit_bond(),
        Err(Error::NoBond.into())
    );
}

#[test]
fn bond_request_unlock_stops_seeding_but_keeps_capital() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    assert_eq!(reg.seed_eligible_bond(alpha), U512::zero(), "cooling-down bond does not seed");
    assert_eq!(reg.bonded_of(alpha), U512::from(BOND), "capital still locked across cooldown");
}

#[test]
fn bond_withdraw_before_cooldown_reverts() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    env.advance_block_time(BOND_UNLOCK_COOLDOWN - 1);
    env.set_caller(alpha);
    assert_eq!(reg.try_withdraw_bond(), Err(Error::CooldownActive.into()));
}

#[test]
fn bond_withdraw_without_request_reverts() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    assert_eq!(reg.try_withdraw_bond(), Err(Error::NotUnlocking.into()));
}

#[test]
fn bond_withdraw_after_cooldown_returns_capital_via_pull_payment() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    env.advance_block_time(BOND_UNLOCK_COOLDOWN);
    env.set_caller(alpha);
    reg.withdraw_bond();
    assert_eq!(reg.bonded_of(alpha), U512::zero(), "bond cleared");
    assert_eq!(
        reg.pending_withdrawals_of(alpha),
        U512::from(BOND),
        "credited to the audited pull-payment ledger"
    );

    let bal_before = env.balance_of(&alpha);
    env.set_caller(alpha);
    reg.withdraw();
    assert_eq!(env.balance_of(&alpha), bal_before + U512::from(BOND));
}

#[test]
fn bond_cancel_unlock_reactivates_seed() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    assert_eq!(reg.seed_eligible_bond(alpha), U512::zero());
    env.set_caller(alpha);
    reg.cancel_bond_unlock();
    assert_eq!(reg.seed_eligible_bond(alpha), U512::from(BOND));
}

#[test]
fn bond_deposit_during_cooldown_reactivates_and_adds() {
    let (env, mut reg, alpha, _) = setup();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    env.set_caller(alpha);
    reg.request_bond_unlock();
    env.set_caller(alpha);
    reg.with_tokens(U512::from(BOND)).deposit_bond();
    assert_eq!(reg.bonded_of(alpha), U512::from(2 * BOND), "added to the existing bond");
    assert_eq!(reg.seed_eligible_bond(alpha), U512::from(2 * BOND), "re-committed: seeds the full amount");
    assert_eq!(reg.bond_unlock_at_of(alpha), 0, "pending unlock cleared by re-deposit");
}

#[test]
fn bond_request_unlock_without_bond_reverts() {
    let (env, mut reg, _, beta) = setup();
    env.set_caller(beta);
    assert_eq!(reg.try_request_bond_unlock(), Err(Error::NoBond.into()));
}
