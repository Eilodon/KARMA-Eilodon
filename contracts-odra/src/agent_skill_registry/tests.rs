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

// ─── Composition primitive (T2.1) ───────────────────────────────────────────
//
// Setup uses three primitives owned by three distinct accounts so revenue split + per-leaf
// reputation are observable independently. The composite wrapper is owned by `omega` so we
// can also verify that wrapper-vs-leaf trust signals route correctly.

const LEAF_PRICE: u64 = 100_000;
const COMPOSITE_PRICE: u64 = 3_000_000;

fn register_leaf(env: &HostEnv, contract: &mut AgentSkillRegistryHostRef, owner: Address, label: &str) -> u64 {
    env.set_caller(owner);
    contract.register_skill(
        format!("leaf-{label}"),
        format!("leaf primitive {label}"),
        format!("mcp://leaf/{label}"),
        U512::from(LEAF_PRICE),
        0,
        IDENTITY_POLICY_NONE,
    )
}

fn register_composite(
    env: &HostEnv,
    contract: &mut AgentSkillRegistryHostRef,
    wrapper_owner: Address,
    leaves: Vec<u64>,
    weights: Vec<u32>,
    price: u64,
) -> u64 {
    env.set_caller(wrapper_owner);
    contract.register_composition(
        "compose-alpha-beta-omega".to_string(),
        "5/3/2 fanout across three primitives".to_string(),
        "mcp://omega/compose".to_string(),
        U512::from(price),
        0,
        IDENTITY_POLICY_NONE,
        leaves,
        weights,
    )
}

#[test]
fn composition_register_persists_and_views_distinguish_composite_from_primitive() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let omega = env.get_account(3);
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let composite = register_composite(
        &env, &mut reg, omega, vec![leaf_a, leaf_b], vec![6_000, 4_000], COMPOSITE_PRICE,
    );

    assert!(reg.is_composite(composite), "wrapper is composite");
    assert!(!reg.is_composite(leaf_a), "leaf is primitive");
    assert!(!reg.is_composite(leaf_b), "leaf is primitive");

    let comp = reg.get_composition(composite).expect("composition present");
    assert_eq!(comp.leaf_skill_ids, vec![leaf_a, leaf_b]);
    assert_eq!(comp.weights_bps, vec![6_000u32, 4_000u32]);

    let wrapper_skill = reg.get_skill(composite);
    assert_eq!(wrapper_skill.owner, omega, "wrapper owner == caller of register_composition");
    assert_eq!(wrapper_skill.price_per_call, U512::from(COMPOSITE_PRICE));
}

#[test]
fn composition_rejects_empty_leaves() {
    let (env, mut reg, _, _) = setup();
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE, vec![], vec![],
        ),
        Err(Error::EmptyComposition.into()),
    );
}

#[test]
fn composition_rejects_weight_length_mismatch() {
    let (env, mut reg, alpha, _) = setup();
    let leaf = register_leaf(&env, &mut reg, alpha, "a");
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![leaf], vec![5_000, 5_000],
        ),
        Err(Error::WeightsMismatch.into()),
    );
}

#[test]
fn composition_rejects_weights_not_summing_to_denominator() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![leaf_a, leaf_b], vec![3_000, 3_000], // sums to 6_000, not 10_000
        ),
        Err(Error::WeightsMismatch.into()),
    );
}

#[test]
fn composition_rejects_unknown_leaf() {
    let (env, mut reg, _, _) = setup();
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![42u64], vec![10_000],
        ),
        Err(Error::LeafSkillNotFound.into()),
    );
}

#[test]
fn composition_rejects_inactive_leaf() {
    let (env, mut reg, alpha, _) = setup();
    let leaf = register_leaf(&env, &mut reg, alpha, "a");
    env.set_caller(alpha);
    reg.deactivate_skill(leaf);
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "c".to_string(), "".to_string(), "mcp://c".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![leaf], vec![10_000],
        ),
        Err(Error::LeafSkillInactive.into()),
    );
}

#[test]
fn composition_rejects_composite_leaf_single_level_only() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let omega = env.get_account(3);
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let composite = register_composite(
        &env, &mut reg, omega, vec![leaf_a, leaf_b], vec![5_000, 5_000], COMPOSITE_PRICE,
    );
    // Try to wrap the composite again — must be rejected.
    let theta = env.get_account(4);
    env.set_caller(theta);
    assert_eq!(
        reg.try_register_composition(
            "c2".to_string(), "".to_string(), "mcp://c2".to_string(),
            U512::from(1u64), 0, IDENTITY_POLICY_NONE,
            vec![composite], vec![10_000],
        ),
        Err(Error::LeafIsComposite.into()),
    );
}

#[test]
fn composition_completion_splits_escrow_per_weights_and_credits_leaf_owners() {
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let gamma = env.get_account(4);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let leaf_c = register_leaf(&env, &mut reg, gamma, "c");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b, leaf_c],
        vec![5_000, 3_000, 2_000], // 50/30/20
        COMPOSITE_PRICE,
    );

    // Requester escrows the composite price; provider (= wrapper owner omega) delivers.
    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("compose-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("compose-result"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    // Each leaf owner has a pending withdrawal == their share of the escrow.
    assert_eq!(
        reg.pending_withdrawals_of(alpha),
        U512::from(COMPOSITE_PRICE * 5_000 / 10_000), "alpha = 50%",
    );
    assert_eq!(
        reg.pending_withdrawals_of(beta),
        U512::from(COMPOSITE_PRICE * 3_000 / 10_000), "beta = 30%",
    );
    assert_eq!(
        reg.pending_withdrawals_of(gamma),
        U512::from(COMPOSITE_PRICE * 2_000 / 10_000), "gamma = 20%",
    );
    // Wrapper owner gets ZERO escrow by default (they get a slice only by including themselves
    // as a leaf — the design point that forces wrapper cuts to be on-chain visible).
    assert_eq!(
        reg.pending_withdrawals_of(omega),
        U512::zero(),
        "wrapper owner has no implicit slice",
    );

    // Σ payouts == escrow_amount (the pull-payment invariant).
    let total = reg.pending_withdrawals_of(alpha)
        + reg.pending_withdrawals_of(beta)
        + reg.pending_withdrawals_of(gamma);
    assert_eq!(total, U512::from(COMPOSITE_PRICE), "escrow fully distributed (no dust lost)");

    // Reputation propagation: each leaf skill + composite all bump by REPUTATION_STEP.
    assert_eq!(reg.get_skill(leaf_a).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(leaf_b).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(leaf_c).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION + REPUTATION_STEP);
    // Each leaf owner + the wrapper owner + the requester all bump in agent rep.
    assert_eq!(reg.agent_reputation(alpha), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(beta), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(gamma), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(omega), BASE_REPUTATION + REPUTATION_STEP);
    assert_eq!(reg.agent_reputation(requester), BASE_REPUTATION + REPUTATION_STEP);
}

#[test]
fn composition_completion_last_leaf_absorbs_rounding_remainder() {
    // 3 leaves with weights that don't divide escrow evenly: 3333/3333/3334 of 1000 motes.
    // 1000 * 3333 / 10000 = 333.3 → 333 each for first two, last one gets 1000-333-333 = 334.
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let gamma = env.get_account(4);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let leaf_c = register_leaf(&env, &mut reg, gamma, "c");
    const DUSTY_PRICE: u64 = 1_000;
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b, leaf_c],
        vec![3_333, 3_333, 3_334],
        DUSTY_PRICE,
    );
    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(DUSTY_PRICE))
        .create_job(composite, task_hash("dust-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("dust-result"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    assert_eq!(reg.pending_withdrawals_of(alpha), U512::from(333u64));
    assert_eq!(reg.pending_withdrawals_of(beta),  U512::from(333u64));
    // Last leaf absorbs the rounding remainder — Σ == escrow (no dust).
    assert_eq!(reg.pending_withdrawals_of(gamma), U512::from(334u64));
    let total = reg.pending_withdrawals_of(alpha)
        + reg.pending_withdrawals_of(beta)
        + reg.pending_withdrawals_of(gamma);
    assert_eq!(total, U512::from(DUSTY_PRICE));
}

#[test]
fn composition_wrapper_can_include_itself_as_leaf_for_explicit_cut() {
    // Wrapper-owner omega registers a primitive of their own, then composes
    // (wrapper-primitive, leaf-a, leaf-b) with a 4_000/3_000/3_000 split — proving the
    // "wrapper cut" is achievable IF AND ONLY IF it appears as an explicit on-chain leaf.
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_omega = register_leaf(&env, &mut reg, omega, "omega");
    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_omega, leaf_a, leaf_b],
        vec![4_000, 3_000, 3_000],
        COMPOSITE_PRICE,
    );

    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("cut-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("cut-result"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    assert_eq!(
        reg.pending_withdrawals_of(omega),
        U512::from(COMPOSITE_PRICE * 4_000 / 10_000),
        "wrapper owner gets exactly the slice tied to their own primitive leaf",
    );
}

// ─── Cross-chain reputation consumer (P0.1) ───────────────────────────────────

#[test]
fn cross_chain_rep_defaults_to_zero() {
    let (env, reg, _, _) = setup();
    let fresh = env.get_account(7);
    assert_eq!(reg.get_cross_chain_rep(fresh), 0);
}

#[test]
fn set_cross_chain_rep_stores_and_reads() {
    let (env, mut reg, _, _) = setup();
    let agent = env.get_account(3);
    // Owner is the deployer (account 0), set during init().
    let owner = env.get_account(0);
    env.set_caller(owner);
    reg.set_cross_chain_rep(agent, 85, "stellar".to_string());
    assert_eq!(reg.get_cross_chain_rep(agent), 85);

    assert!(env.emitted_event(
        &reg,
        CrossChainRepUpdated {
            agent,
            score: 85,
            source_chain: "stellar".to_string(),
        }
    ));
}

#[test]
fn set_cross_chain_rep_overwrites() {
    let (env, mut reg, _, _) = setup();
    let agent = env.get_account(3);
    let owner = env.get_account(0);
    env.set_caller(owner);
    reg.set_cross_chain_rep(agent, 70, "stellar".to_string());
    assert_eq!(reg.get_cross_chain_rep(agent), 70);
    env.set_caller(owner);
    reg.set_cross_chain_rep(agent, 95, "stellar".to_string());
    assert_eq!(reg.get_cross_chain_rep(agent), 95);
}

#[test]
fn set_cross_chain_rep_rejects_non_owner() {
    let (env, mut reg, alpha, _) = setup();
    let agent = env.get_account(3);
    env.set_caller(alpha); // not the deployer/owner
    assert_eq!(
        reg.try_set_cross_chain_rep(agent, 80, "stellar".to_string()),
        Err(Error::NotContractOwner.into())
    );
}

#[test]
fn set_cross_chain_rep_rejects_score_over_max() {
    let (env, mut reg, _, _) = setup();
    let agent = env.get_account(3);
    let owner = env.get_account(0);
    env.set_caller(owner);
    assert_eq!(
        reg.try_set_cross_chain_rep(agent, 101, "stellar".to_string()),
        Err(Error::BadThreshold.into())
    );
}

// ─── Ported from PR#7 (claude/karma-t2-1-skill-composition-odra) ──────────────
// PR#7 and this branch implement T2.1 with different revenue-split designs (PR#7:
// explicit `orchestrator_bps` + dust-to-orchestrator; here: weights sum to 10_000,
// wrapper-as-explicit-leaf, dust-to-last-leaf). The three cases below cover PR#7
// invariants that had no twin here — the leaf-count bound, the composite dispute
// refund, and the per-leaf self-deal carve-out — re-expressed for this design.

#[test]
fn composition_rejects_more_than_max_leaves() {
    // MAX_COMPOSITION_LEAVES + 1 distinct active leaves must be rejected. The leaf-count
    // bound is the first structural guard after the empty check, so it fires before the
    // weights-sum check regardless of the weight values.
    let (env, mut reg, alpha, _) = setup();
    let n = (MAX_COMPOSITION_LEAVES + 1) as usize;
    let mut leaves = Vec::with_capacity(n);
    for i in 0..n {
        leaves.push(register_leaf(&env, &mut reg, alpha, &format!("m{i}")));
    }
    let weights = vec![WEIGHT_DENOMINATOR / n as u32; n];
    let omega = env.get_account(3);
    env.set_caller(omega);
    assert_eq!(
        reg.try_register_composition(
            "too-many".to_string(), "".to_string(), "mcp://too-many".to_string(),
            U512::from(COMPOSITE_PRICE), 0, IDENTITY_POLICY_NONE,
            leaves, weights,
        ),
        Err(Error::TooManyLeaves.into()),
    );
}

#[test]
fn composition_dispute_refunds_full_escrow_and_freezes_reputation() {
    // Disputing a composite job refunds the WHOLE escrow to the requester — no leaf owner
    // and no wrapper owner is paid — and bumps nobody's reputation.
    let (env, mut reg, alpha, _) = setup();
    let beta = env.get_account(2);
    let gamma = env.get_account(4);
    let omega = env.get_account(3);
    let requester = env.get_account(5);

    let leaf_a = register_leaf(&env, &mut reg, alpha, "a");
    let leaf_b = register_leaf(&env, &mut reg, beta, "b");
    let leaf_c = register_leaf(&env, &mut reg, gamma, "c");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b, leaf_c],
        vec![5_000, 3_000, 2_000],
        COMPOSITE_PRICE,
    );

    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("disp-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("garbage"));
    env.set_caller(requester);
    reg.dispute_result(job_id);

    // Full escrow back to requester; every producer slice is zero.
    assert_eq!(reg.pending_withdrawals_of(requester), U512::from(COMPOSITE_PRICE), "full refund");
    assert_eq!(reg.pending_withdrawals_of(alpha), U512::zero(), "leaf A unpaid on dispute");
    assert_eq!(reg.pending_withdrawals_of(beta), U512::zero(), "leaf B unpaid on dispute");
    assert_eq!(reg.pending_withdrawals_of(gamma), U512::zero(), "leaf C unpaid on dispute");
    assert_eq!(reg.pending_withdrawals_of(omega), U512::zero(), "wrapper unpaid on dispute");

    // Dispute never moves trust signals.
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION, "composite rep frozen");
    assert_eq!(reg.get_skill(leaf_a).reputation_score, BASE_REPUTATION, "leaf A rep frozen");
    assert_eq!(reg.get_skill(leaf_b).reputation_score, BASE_REPUTATION, "leaf B rep frozen");
    assert_eq!(reg.get_skill(leaf_c).reputation_score, BASE_REPUTATION, "leaf C rep frozen");
}

#[test]
fn composition_settle_self_deal_leaf_paid_but_no_reputation() {
    // A leaf whose owner is ALSO the requester is still PAID (payment is not a self-deal
    // guard) but earns NO reputation; the arm's-length leaf and the composite wrapper do.
    let (env, mut reg, _, _) = setup();
    let requester = env.get_account(1); // also owns leaf_a → the self-deal target
    let arms = env.get_account(2);
    let omega = env.get_account(3);

    let leaf_a = register_leaf(&env, &mut reg, requester, "self");
    let leaf_b = register_leaf(&env, &mut reg, arms, "arms");
    let composite = register_composite(
        &env, &mut reg, omega,
        vec![leaf_a, leaf_b],
        vec![6_000, 4_000],
        COMPOSITE_PRICE,
    );

    env.set_caller(requester);
    let job_id = reg
        .with_tokens(U512::from(COMPOSITE_PRICE))
        .create_job(composite, task_hash("self-job"), DEADLINE_MS);
    env.set_caller(omega);
    reg.deliver_result(job_id, task_hash("ok"));
    env.set_caller(requester);
    reg.confirm_completion(job_id);

    // Payment is unconditional — the self-dealing leaf owner (= requester) is still paid.
    assert_eq!(
        reg.pending_withdrawals_of(requester),
        U512::from(COMPOSITE_PRICE * 6_000 / 10_000), "leaf A (self) paid 60%",
    );
    assert_eq!(
        reg.pending_withdrawals_of(arms),
        U512::from(COMPOSITE_PRICE * 4_000 / 10_000), "leaf B (arm's length) paid 40%",
    );

    // Reputation: self-deal leaf frozen; arm's-length leaf + composite bump.
    assert_eq!(reg.get_skill(leaf_a).reputation_score, BASE_REPUTATION, "self-deal leaf rep frozen");
    assert_eq!(reg.get_skill(leaf_b).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "arm's-length leaf bumped");
    assert_eq!(reg.get_skill(composite).reputation_score, BASE_REPUTATION + REPUTATION_STEP, "composite bumped");

    // Requester earns exactly one step (the composite layer), not a second from leaf_a.
    assert_eq!(reg.agent_reputation(requester), BASE_REPUTATION + REPUTATION_STEP, "requester one composite-layer bump");
    assert_eq!(reg.agent_reputation(arms), BASE_REPUTATION + REPUTATION_STEP, "arm's-length leaf owner bumped");
}
