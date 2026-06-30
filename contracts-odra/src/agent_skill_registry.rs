//! `AgentSkillRegistry` — Odra port of `contracts/AgentSkillRegistry.sol`.
//!
//! All public functions mirror the Solidity surface 1-to-1 in name and semantics. Diffs
//! that matter are inlined as comments at the call sites.

use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::U512;
use odra::prelude::*;

// ─── Constants ─────────────────────────────────────────────────────────────
//
// Reputation lives on a `u32` 0..=100 axis. The `_agent_rep` map uses `0` as the unset
// sentinel for lazy `BASE_REPUTATION` (50) initialisation — same invariant as Solidity.
pub const BASE_REPUTATION: u32 = 50;
pub const MAX_REPUTATION: u32 = 100;
pub const REPUTATION_STEP: u32 = 5;

// Casper block time is in **milliseconds** — every duration here is ms.
pub const MIN_REVIEW_WINDOW: u64 = 60 * 60 * 1_000; // 1 hour
pub const MAX_REVIEW_WINDOW: u64 = 30 * 24 * 60 * 60 * 1_000; // 30 days
pub const DEFAULT_REVIEW_WINDOW: u64 = 3 * 24 * 60 * 60 * 1_000; // 3 days
pub const BOND_UNLOCK_COOLDOWN: u64 = 7 * 24 * 60 * 60 * 1_000; // 7 days

// Identity policy values — documented in the Solidity contract and the README.
//   0 NONE · 1 T3N_VERIFIED · 2 T3N_VERIFIED_FRESH · ≥3 unknown ⇒ off-chain server fails closed.
pub const IDENTITY_POLICY_NONE: u8 = 0;
pub const IDENTITY_POLICY_T3N: u8 = 1;
pub const IDENTITY_POLICY_T3N_FRESH: u8 = 2;

// Composition primitive (T2.1). Weights live on a basis-points axis (10_000 = 100%) so
// integer arithmetic stays exact and the `register_composition` validation is a clean
// `sum == WEIGHT_DENOMINATOR` check. Single-level only for hackathon scope: a leaf may
// not itself be a composition.
pub const WEIGHT_DENOMINATOR: u32 = 10_000;
pub const MAX_COMPOSITION_LEAVES: u32 = 8;

// ─── Errors ────────────────────────────────────────────────────────────────
#[odra::odra_error]
pub enum Error {
    NameRequired = 1,
    BadThreshold = 2,
    NotSkillOwner = 3,
    AlreadyInactive = 4,
    SkillNotFound = 5,
    SkillInactive = 6,
    EscrowMustEqualPrice = 7,
    DeadlineRequired = 8,
    InsufficientReputation = 9,
    DuplicateTaskHash = 10,
    NotProvider = 11,
    JobNotOpen = 12,
    NotRequester = 13,
    JobNotDelivered = 14,
    ReviewWindowOpen = 15,
    ReviewWindowClosed = 16,
    NotRefundable = 17,
    BeforeDeadline = 18,
    NothingToWithdraw = 19,
    NoBond = 20,
    AlreadyUnlocking = 21,
    NotUnlocking = 22,
    CooldownActive = 23,
    BadReviewWindow = 24,
    // ── Composition primitive (T2.1) ──
    EmptyComposition = 25,
    TooManyLeaves = 26,
    WeightsMismatch = 27,
    LeafSkillNotFound = 28,
    LeafSkillInactive = 29,
    LeafIsComposite = 30,
    // ── Cross-chain reputation consumer (P0.1) ──
    NotContractOwner = 31,
    // ── P0-A: Evaluator Agent ──
    EvaluatorRequired = 32,
    EvaluatorCannotBeRequester = 33,
    EvaluatorCannotBeProvider = 34,
    NotEvaluator = 35,
}

// ─── Types ─────────────────────────────────────────────────────────────────
/// Status guard for every state-transition guard. Rust's exhaustive `match` means any future
/// variant must be considered at every site — a compile-time state machine, per the team
/// blueprint's pattern-matched-status claim.
#[odra::odra_type]
pub enum JobStatus {
    Open,
    Delivered,
    Completed,
    Refunded,
    Disputed,
}

#[odra::odra_type]
pub struct Skill {
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub mcp_endpoint: String,
    pub price_per_call: U512,
    pub reputation_score: u32,
    pub total_invocations: u64,
    pub active: bool,
    pub registered_at: u64,
    pub min_reputation_to_invoke: u32,
    pub identity_policy: u8,
}

#[odra::odra_type]
pub struct Job {
    pub requester: Address,
    pub provider: Address,
    pub skill_id: u64,
    pub task_hash: Bytes,
    pub escrow_amount: U512,
    /// Open-state: refund-after deadline. After [`deliver_result`] it is repurposed as the
    /// review-window deadline (a status guard keeps the two phases from leaking — Solidity FM1).
    pub deadline: u64,
    pub status: JobStatus,
    pub result_hash: Bytes,
    pub created_at: u64,
    pub completed_at: u64,
    /// P0-A: neutral 3rd-party verifier; `None` = no evaluator (opt-in).
    pub evaluator: Option<Address>,
    /// P0-A: fee held for the evaluator; refunded to requester if unused.
    pub evaluator_fee: U512,
}

// ─── Events ────────────────────────────────────────────────────────────────
#[odra::event]
pub struct SkillRegistered {
    pub skill_id: u64,
    pub owner: Address,
    pub name: String,
    pub price_per_call: U512,
}

#[odra::event]
pub struct SkillDeactivated {
    pub skill_id: u64,
}

#[odra::event]
pub struct JobCreated {
    pub job_id: u64,
    pub requester: Address,
    pub skill_id: u64,
    pub escrow: U512,
    pub deadline: u64,
}

#[odra::event]
pub struct ResultDelivered {
    pub job_id: u64,
    pub result_hash: Bytes,
}

#[odra::event]
pub struct JobCompleted {
    pub job_id: u64,
    pub provider: Address,
    pub payout: U512,
    pub new_reputation: u32,
}

#[odra::event]
pub struct JobRefunded {
    pub job_id: u64,
    pub requester: Address,
    pub amount: U512,
}

#[odra::event]
pub struct ResultDisputed {
    pub job_id: u64,
    pub requester: Address,
    pub amount: U512,
}

#[odra::event]
pub struct MinReputationSet {
    pub skill_id: u64,
    pub min_reputation: u32,
}

#[odra::event]
pub struct IdentityPolicySet {
    pub skill_id: u64,
    pub policy: u8,
}

#[odra::event]
pub struct Withdrawn {
    pub who: Address,
    pub amount: U512,
}

#[odra::event]
pub struct BondUpdated {
    pub agent: Address,
    pub bonded_amount: U512,
    pub seed_eligible: U512,
}

// ── P0-A Evaluator event ────────────────────────────────────────────────────
#[odra::event]
pub struct JobEvaluated {
    pub job_id: u64,
    pub evaluator: Address,
    pub approved: bool,
    pub evaluator_payout: U512,
}

// ── Cross-chain reputation consumer events (P0.1) ───────────────────────────
#[odra::event]
pub struct CrossChainRepUpdated {
    pub agent: Address,
    pub score: u32,
    pub source_chain: String,
}

// ── Composition events (T2.1) ────────────────────────────────────────────────
#[odra::event]
pub struct CompositionRegistered {
    pub skill_id: u64,
    pub owner: Address,
    pub leaf_skill_ids: Vec<u64>,
    pub weights_bps: Vec<u32>,
}

#[odra::event]
pub struct CompositionLeafPayout {
    pub job_id: u64,
    pub composite_skill_id: u64,
    pub leaf_skill_id: u64,
    pub leaf_owner: Address,
    pub payout: U512,
}

// ── Composition type (T2.1) ──────────────────────────────────────────────────
/// Single-level composition: a wrapper skill that fans out one job's escrow across
/// `leaf_skill_ids` according to `weights_bps`. Self-cuts are explicit — if the wrapper
/// owner wants a slice, the wrapper registers one of its OWN primitive skills as a leaf.
#[odra::odra_type]
pub struct Composition {
    pub leaf_skill_ids: Vec<u64>,
    pub weights_bps: Vec<u32>,
}

// ─── Contract ──────────────────────────────────────────────────────────────
#[odra::module(events = [
    SkillRegistered, SkillDeactivated, JobCreated, ResultDelivered, JobCompleted,
    JobRefunded, ResultDisputed, JobEvaluated, MinReputationSet, IdentityPolicySet,
    Withdrawn, BondUpdated, CompositionRegistered, CompositionLeafPayout, CrossChainRepUpdated,
])]
pub struct AgentSkillRegistry {
    review_window: Var<u64>,
    skill_id_counter: Var<u64>,
    job_id_counter: Var<u64>,
    skills: Mapping<u64, Skill>,
    jobs: Mapping<u64, Job>,
    agent_provider_jobs: Mapping<Address, Vec<u64>>,
    agent_requester_jobs: Mapping<Address, Vec<u64>>,
    agent_skills: Mapping<Address, Vec<u64>>,
    pending_withdrawals: Mapping<Address, U512>,
    job_by_task_hash: Mapping<Bytes, u64>,
    agent_rep: Mapping<Address, u32>,
    bonded_amount: Mapping<Address, U512>,
    bond_unlock_at: Mapping<Address, u64>,
    /// Composite skills (T2.1). Empty entry = primitive skill; present entry = composite.
    /// Lookup is keyed by the wrapper's `skill_id` (same id space as `skills`).
    compositions: Mapping<u64, Composition>,
    /// Cross-chain reputation (P0.1). Admin-gated bridge from Soroban verifier attestations.
    cross_chain_rep: Mapping<Address, u32>,
    /// Contract owner (set at init, used for admin-gated cross-chain rep updates).
    owner: Var<Address>,
}

#[odra::module]
impl AgentSkillRegistry {
    /// Deploy-time configured, then immutable. Bounded to `[MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW]`.
    pub fn init(&mut self, review_window_ms: u64) {
        if review_window_ms < MIN_REVIEW_WINDOW || review_window_ms > MAX_REVIEW_WINDOW {
            self.env().revert(Error::BadReviewWindow);
        }
        self.review_window.set(review_window_ms);
        self.owner.set(self.env().caller());
    }

    // ── Skill lifecycle ────────────────────────────────────────────────────
    pub fn register_skill(
        &mut self,
        name: String,
        description: String,
        mcp_endpoint: String,
        price_per_call: U512,
        min_reputation_to_invoke: u32,
        identity_policy: u8,
    ) -> u64 {
        if name.is_empty() {
            self.env().revert(Error::NameRequired);
        }
        if min_reputation_to_invoke > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        let skill_id = self.skill_id_counter.get_or_default() + 1;
        self.skill_id_counter.set(skill_id);

        let owner = self.env().caller();
        let now = self.env().get_block_time();
        let skill = Skill {
            owner,
            name: name.clone(),
            description,
            mcp_endpoint,
            price_per_call,
            reputation_score: BASE_REPUTATION,
            total_invocations: 0,
            active: true,
            registered_at: now,
            min_reputation_to_invoke,
            identity_policy,
        };
        self.skills.set(&skill_id, skill);

        let mut owned = self.agent_skills.get(&owner).unwrap_or_default();
        owned.push(skill_id);
        self.agent_skills.set(&owner, owned);

        self.env().emit_event(SkillRegistered {
            skill_id,
            owner,
            name,
            price_per_call,
        });
        skill_id
    }

    /// Register a composite skill (T2.1). The wrapper itself is a normal Skill entry; the
    /// `compositions` map records its leaf split. Constraints (all asserted on-chain):
    ///   - 1 ≤ leaves ≤ MAX_COMPOSITION_LEAVES
    ///   - `weights_bps.len() == leaf_skill_ids.len()`
    ///   - Σ weights_bps == WEIGHT_DENOMINATOR (10_000)
    ///   - every leaf_skill_id exists, is active, and is NOT itself a composition
    ///     (single-level only for hackathon scope)
    /// Reputation/identity gates on the WRAPPER are inherited from the wrapper's own Skill
    /// entry, so a composite can be gated independently of its leaves' gates.
    pub fn register_composition(
        &mut self,
        name: String,
        description: String,
        mcp_endpoint: String,
        price_per_call: U512,
        min_reputation_to_invoke: u32,
        identity_policy: u8,
        leaf_skill_ids: Vec<u64>,
        weights_bps: Vec<u32>,
    ) -> u64 {
        if leaf_skill_ids.is_empty() {
            self.env().revert(Error::EmptyComposition);
        }
        if leaf_skill_ids.len() as u32 > MAX_COMPOSITION_LEAVES {
            self.env().revert(Error::TooManyLeaves);
        }
        if leaf_skill_ids.len() != weights_bps.len() {
            self.env().revert(Error::WeightsMismatch);
        }
        let mut sum: u32 = 0;
        for w in weights_bps.iter() {
            sum = sum.saturating_add(*w);
        }
        if sum != WEIGHT_DENOMINATOR {
            self.env().revert(Error::WeightsMismatch);
        }
        for leaf_id in leaf_skill_ids.iter() {
            let leaf = self
                .skills
                .get(leaf_id)
                .unwrap_or_else(|| self.env().revert(Error::LeafSkillNotFound));
            if !leaf.active {
                self.env().revert(Error::LeafSkillInactive);
            }
            if self.compositions.get(leaf_id).is_some() {
                // Single-level only: leaves must be primitive. Lifts hackathon-scope ambiguity
                // about whether revenue/rep should cascade transitively. Revisit post-hackathon.
                self.env().revert(Error::LeafIsComposite);
            }
        }

        // Register the wrapper as a normal Skill entry — same id space — then attach the
        // composition record under that id. Reusing `register_skill`'s shape keeps discovery
        // and gating logic untouched.
        let skill_id = self.register_skill(
            name,
            description,
            mcp_endpoint,
            price_per_call,
            min_reputation_to_invoke,
            identity_policy,
        );
        let composition = Composition {
            leaf_skill_ids: leaf_skill_ids.clone(),
            weights_bps: weights_bps.clone(),
        };
        self.compositions.set(&skill_id, composition);

        let owner = self.env().caller();
        self.env().emit_event(CompositionRegistered {
            skill_id,
            owner,
            leaf_skill_ids,
            weights_bps,
        });
        skill_id
    }

    /// View: returns the composition record for a composite skill, or None for a primitive.
    pub fn get_composition(&self, skill_id: u64) -> Option<Composition> {
        self.compositions.get(&skill_id)
    }

    /// View: convenience boolean — is this skill a composite?
    pub fn is_composite(&self, skill_id: u64) -> bool {
        self.compositions.get(&skill_id).is_some()
    }

    pub fn deactivate_skill(&mut self, skill_id: u64) {
        let mut s = self.require_skill(skill_id);
        if s.owner != self.env().caller() {
            self.env().revert(Error::NotSkillOwner);
        }
        if !s.active {
            self.env().revert(Error::AlreadyInactive);
        }
        s.active = false;
        self.skills.set(&skill_id, s);
        self.env().emit_event(SkillDeactivated { skill_id });
    }

    pub fn set_min_reputation(&mut self, skill_id: u64, min_reputation: u32) {
        let mut s = self.require_skill(skill_id);
        if s.owner != self.env().caller() {
            self.env().revert(Error::NotSkillOwner);
        }
        if min_reputation > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        s.min_reputation_to_invoke = min_reputation;
        self.skills.set(&skill_id, s);
        self.env().emit_event(MinReputationSet { skill_id, min_reputation });
    }

    pub fn set_identity_policy(&mut self, skill_id: u64, policy: u8) {
        let mut s = self.require_skill(skill_id);
        if s.owner != self.env().caller() {
            self.env().revert(Error::NotSkillOwner);
        }
        s.identity_policy = policy;
        self.skills.set(&skill_id, s);
        self.env().emit_event(IdentityPolicySet { skill_id, policy });
    }

    // ── Reputation ─────────────────────────────────────────────────────────
    pub fn agent_reputation(&self, agent: Address) -> u32 {
        let r = self.agent_rep.get(&agent).unwrap_or(0);
        if r == 0 { BASE_REPUTATION } else { r }
    }

    // ── Job lifecycle ──────────────────────────────────────────────────────
    /// Payable. Backward-compatible wrapper — creates a job without an evaluator.
    #[odra(payable)]
    pub fn create_job(&mut self, skill_id: u64, task_hash: Bytes, deadline_secs: u64) -> u64 {
        self._create_job(skill_id, task_hash, deadline_secs, None, U512::zero())
    }

    /// Payable. Create a job with a neutral third-party evaluator (P0-A).
    /// `attached_value` must equal `price_per_call + evaluator_fee`.
    #[odra(payable)]
    pub fn create_job_with_evaluator(
        &mut self,
        skill_id: u64,
        task_hash: Bytes,
        deadline_secs: u64,
        evaluator: Address,
        evaluator_fee: U512,
    ) -> u64 {
        let caller = self.env().caller();
        if evaluator == caller {
            self.env().revert(Error::EvaluatorCannotBeRequester);
        }
        self._create_job(skill_id, task_hash, deadline_secs, Some(evaluator), evaluator_fee)
    }

    pub fn deliver_result(&mut self, job_id: u64, result_hash: Bytes) {
        let mut j = self.require_job(job_id);
        if j.provider != self.env().caller() {
            self.env().revert(Error::NotProvider);
        }
        if j.status != JobStatus::Open {
            self.env().revert(Error::JobNotOpen);
        }
        j.status = JobStatus::Delivered;
        j.result_hash = result_hash.clone();
        // Repurpose `deadline` as the review-by time. `claim_refund`'s `status == Open` guard
        // stops cross-talk (Solidity FM1 audit).
        j.deadline = self.env().get_block_time() + self.review_window.get_or_default();
        self.jobs.set(&job_id, j);
        self.env().emit_event(ResultDelivered { job_id, result_hash });
    }

    pub fn confirm_completion(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.requester != self.env().caller() {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        // Evaluator fee refund: requester acted directly, evaluator didn't — fee returns to requester.
        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&j.requester, credit);
        }
        self.settle_completion(&mut j, job_id);
        self.jobs.set(&job_id, j);
    }

    pub fn claim_after_review(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.provider != self.env().caller() {
            self.env().revert(Error::NotProvider);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() <= j.deadline {
            self.env().revert(Error::ReviewWindowOpen);
        }
        // Evaluator fee refund: evaluator didn't act — fee returns to requester.
        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&j.requester, credit);
        }
        self.settle_completion(&mut j, job_id);
        self.jobs.set(&job_id, j);
    }

    pub fn dispute_result(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.requester != self.env().caller() {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() > j.deadline {
            self.env().revert(Error::ReviewWindowClosed);
        }
        j.status = JobStatus::Disputed;
        // Escrow + evaluator fee both return to requester (evaluator didn't act).
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
            + j.escrow_amount + j.evaluator_fee;
        self.pending_withdrawals.set(&j.requester, credit);
        let amount = j.escrow_amount;
        let requester = j.requester;
        self.jobs.set(&job_id, j);
        self.env().emit_event(ResultDisputed { job_id, requester, amount });
    }

    /// Evaluator approves or rejects a delivered result (P0-A). Only callable by the job's
    /// designated evaluator within the review window. The evaluator fee is released regardless.
    pub fn evaluate_result(&mut self, job_id: u64, approved: bool) {
        let mut j = self.require_job(job_id);
        let caller = self.env().caller();
        match j.evaluator {
            Some(ev) if ev == caller => {},
            _ => self.env().revert(Error::NotEvaluator),
        }
        if j.status != JobStatus::Delivered {
            self.env().revert(Error::JobNotDelivered);
        }
        if self.env().get_block_time() > j.deadline {
            self.env().revert(Error::ReviewWindowClosed);
        }

        // Evaluator fee released to evaluator regardless of verdict.
        if !j.evaluator_fee.is_zero() {
            let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + j.evaluator_fee;
            self.pending_withdrawals.set(&caller, credit);
        }
        self.env().emit_event(JobEvaluated {
            job_id,
            evaluator: caller,
            approved,
            evaluator_payout: j.evaluator_fee,
        });

        if approved {
            self.settle_completion(&mut j, job_id);
        } else {
            j.status = JobStatus::Disputed;
            let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default() + j.escrow_amount;
            self.pending_withdrawals.set(&j.requester, credit);
            let amount = j.escrow_amount;
            let requester = j.requester;
            self.env().emit_event(ResultDisputed { job_id, requester, amount });
        }
        self.jobs.set(&job_id, j);
    }

    pub fn claim_refund(&mut self, job_id: u64) {
        let mut j = self.require_job(job_id);
        if j.requester != self.env().caller() {
            self.env().revert(Error::NotRequester);
        }
        if j.status != JobStatus::Open {
            self.env().revert(Error::NotRefundable);
        }
        if self.env().get_block_time() <= j.deadline {
            self.env().revert(Error::BeforeDeadline);
        }
        j.status = JobStatus::Refunded;
        // Escrow + evaluator fee both return to requester.
        let credit = self.pending_withdrawals.get(&j.requester).unwrap_or_default()
            + j.escrow_amount + j.evaluator_fee;
        self.pending_withdrawals.set(&j.requester, credit);
        let amount = j.escrow_amount;
        let requester = j.requester;
        self.jobs.set(&job_id, j);
        self.env().emit_event(JobRefunded { job_id, requester, amount });
    }

    // ── Pull-payment ───────────────────────────────────────────────────────
    /// CEI: ledger zeroed BEFORE the transfer. Casper's execution model is per-deploy isolated,
    /// so cross-call re-entrancy of the Solidity flavour isn't reachable; we still keep the
    /// zero-before-pay pattern for parity with the audited Solidity (and for any future cross-
    /// contract `transfer_tokens` invariants).
    pub fn withdraw(&mut self) {
        let caller = self.env().caller();
        let amount = self.pending_withdrawals.get(&caller).unwrap_or_default();
        if amount.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }
        self.pending_withdrawals.set(&caller, U512::zero());
        self.env().transfer_tokens(&caller, &amount);
        self.env().emit_event(Withdrawn { who: caller, amount });
    }

    // ── Tier-2 Sybil-resistance bond (PD-007) ──────────────────────────────
    pub fn seed_eligible_bond(&self, agent: Address) -> U512 {
        if self.bond_unlock_at.get(&agent).unwrap_or(0) == 0 {
            self.bonded_amount.get(&agent).unwrap_or_default()
        } else {
            U512::zero()
        }
    }

    #[odra(payable)]
    pub fn deposit_bond(&mut self) {
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::NoBond);
        }
        let caller = self.env().caller();
        let bonded = self.bonded_amount.get(&caller).unwrap_or_default() + amount;
        self.bonded_amount.set(&caller, bonded);
        self.bond_unlock_at.set(&caller, 0);
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: bonded,
            seed_eligible: bonded,
        });
    }

    pub fn request_bond_unlock(&mut self) {
        let caller = self.env().caller();
        let bonded = self.bonded_amount.get(&caller).unwrap_or_default();
        if bonded.is_zero() {
            self.env().revert(Error::NoBond);
        }
        if self.bond_unlock_at.get(&caller).unwrap_or(0) != 0 {
            self.env().revert(Error::AlreadyUnlocking);
        }
        let unlock_at = self.env().get_block_time() + BOND_UNLOCK_COOLDOWN;
        self.bond_unlock_at.set(&caller, unlock_at);
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: bonded,
            seed_eligible: U512::zero(),
        });
    }

    pub fn cancel_bond_unlock(&mut self) {
        let caller = self.env().caller();
        if self.bond_unlock_at.get(&caller).unwrap_or(0) == 0 {
            self.env().revert(Error::NotUnlocking);
        }
        self.bond_unlock_at.set(&caller, 0);
        let bonded = self.bonded_amount.get(&caller).unwrap_or_default();
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: bonded,
            seed_eligible: bonded,
        });
    }

    pub fn withdraw_bond(&mut self) {
        let caller = self.env().caller();
        let unlock_at = self.bond_unlock_at.get(&caller).unwrap_or(0);
        if unlock_at == 0 {
            self.env().revert(Error::NotUnlocking);
        }
        if self.env().get_block_time() < unlock_at {
            self.env().revert(Error::CooldownActive);
        }
        let amount = self.bonded_amount.get(&caller).unwrap_or_default();
        self.bonded_amount.set(&caller, U512::zero());
        self.bond_unlock_at.set(&caller, 0);
        let credit = self.pending_withdrawals.get(&caller).unwrap_or_default() + amount;
        self.pending_withdrawals.set(&caller, credit);
        self.env().emit_event(BondUpdated {
            agent: caller,
            bonded_amount: U512::zero(),
            seed_eligible: U512::zero(),
        });
    }

    // ── Cross-chain reputation consumer (P0.1) ──────────────────────────────
    //
    // Odra cannot verify Soroban Groth16 proofs directly. Instead, the contract owner
    // (trusted bridge) attests cross-chain reputation based on verified Soroban credentials.
    // This mirrors the Soroban `admin_set_cross_chain_rep` pattern.

    /// Set an agent's cross-chain reputation. Owner-only (trusted bridge from Soroban).
    pub fn set_cross_chain_rep(&mut self, agent: Address, score: u32, source_chain: String) {
        let owner = self.owner.get().unwrap_or_else(|| self.env().revert(Error::NotContractOwner));
        if owner != self.env().caller() {
            self.env().revert(Error::NotContractOwner);
        }
        if score > MAX_REPUTATION {
            self.env().revert(Error::BadThreshold);
        }
        self.cross_chain_rep.set(&agent, score);
        self.env().emit_event(CrossChainRepUpdated {
            agent,
            score,
            source_chain,
        });
    }

    /// Query cross-chain reputation for an agent. Returns 0 if no attestation exists.
    pub fn get_cross_chain_rep(&self, agent: Address) -> u32 {
        self.cross_chain_rep.get(&agent).unwrap_or(0)
    }

    // ── Views ──────────────────────────────────────────────────────────────
    pub fn get_provider_jobs(&self, agent: Address) -> Vec<u64> {
        self.agent_provider_jobs.get(&agent).unwrap_or_default()
    }

    pub fn get_requester_jobs(&self, agent: Address) -> Vec<u64> {
        self.agent_requester_jobs.get(&agent).unwrap_or_default()
    }

    pub fn get_agent_skills(&self, agent: Address) -> Vec<u64> {
        self.agent_skills.get(&agent).unwrap_or_default()
    }

    pub fn skill_count(&self) -> u64 {
        self.skill_id_counter.get_or_default()
    }

    pub fn job_count(&self) -> u64 {
        self.job_id_counter.get_or_default()
    }

    pub fn review_window(&self) -> u64 {
        self.review_window.get_or_default()
    }

    pub fn get_skill(&self, skill_id: u64) -> Skill {
        self.require_skill(skill_id)
    }

    pub fn get_job(&self, job_id: u64) -> Job {
        self.require_job(job_id)
    }

    pub fn pending_withdrawals_of(&self, agent: Address) -> U512 {
        self.pending_withdrawals.get(&agent).unwrap_or_default()
    }

    pub fn job_id_for_task_hash(&self, task_hash: Bytes) -> u64 {
        self.job_by_task_hash.get(&task_hash).unwrap_or(0)
    }

    pub fn bonded_of(&self, agent: Address) -> U512 {
        self.bonded_amount.get(&agent).unwrap_or_default()
    }

    pub fn bond_unlock_at_of(&self, agent: Address) -> u64 {
        self.bond_unlock_at.get(&agent).unwrap_or(0)
    }

    /// P0-A view: returns the evaluator address and fee for a job.
    pub fn get_job_evaluator(&self, job_id: u64) -> (Option<Address>, U512) {
        let j = self.require_job(job_id);
        (j.evaluator, j.evaluator_fee)
    }
}

// Private helpers — `#[odra::module]` impl block above only carries the public surface.
impl AgentSkillRegistry {
    fn _create_job(
        &mut self,
        skill_id: u64,
        task_hash: Bytes,
        deadline_secs: u64,
        evaluator: Option<Address>,
        evaluator_fee: U512,
    ) -> u64 {
        let s = self.require_skill(skill_id);
        if !s.active {
            self.env().revert(Error::SkillInactive);
        }
        let attached = self.env().attached_value();
        if attached != s.price_per_call + evaluator_fee {
            self.env().revert(Error::EscrowMustEqualPrice);
        }
        if deadline_secs == 0 {
            self.env().revert(Error::DeadlineRequired);
        }
        let caller = self.env().caller();
        if self.agent_reputation(caller) < s.min_reputation_to_invoke {
            self.env().revert(Error::InsufficientReputation);
        }
        if let Some(ev) = evaluator {
            if ev == s.owner {
                self.env().revert(Error::EvaluatorCannotBeProvider);
            }
        }
        if self.job_by_task_hash.get(&task_hash).unwrap_or(0) != 0 {
            self.env().revert(Error::DuplicateTaskHash);
        }

        let job_id = self.job_id_counter.get_or_default() + 1;
        self.job_id_counter.set(job_id);

        let now = self.env().get_block_time();
        let job = Job {
            requester: caller,
            provider: s.owner,
            skill_id,
            task_hash: task_hash.clone(),
            escrow_amount: s.price_per_call,
            deadline: now + deadline_secs,
            status: JobStatus::Open,
            result_hash: Bytes::new(),
            created_at: now,
            completed_at: 0,
            evaluator,
            evaluator_fee,
        };
        self.jobs.set(&job_id, job.clone());

        let mut rq = self.agent_requester_jobs.get(&caller).unwrap_or_default();
        rq.push(job_id);
        self.agent_requester_jobs.set(&caller, rq);

        let mut pv = self.agent_provider_jobs.get(&s.owner).unwrap_or_default();
        pv.push(job_id);
        self.agent_provider_jobs.set(&s.owner, pv);

        self.job_by_task_hash.set(&task_hash, job_id);

        self.env().emit_event(JobCreated {
            job_id,
            requester: caller,
            skill_id,
            escrow: job.escrow_amount,
            deadline: job.deadline,
        });
        job_id
    }

    fn require_skill(&self, skill_id: u64) -> Skill {
        self.skills
            .get(&skill_id)
            .unwrap_or_else(|| self.env().revert(Error::SkillNotFound))
    }

    fn require_job(&self, job_id: u64) -> Job {
        self.jobs
            .get(&job_id)
            .unwrap_or_else(|| self.env().revert(Error::JobNotOpen))
    }

    fn bump_agent_rep(&mut self, agent: Address) {
        let next = self.agent_reputation(agent).saturating_add(REPUTATION_STEP);
        let capped = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
        self.agent_rep.set(&agent, capped);
    }

    /// Shared completion effects for [`confirm_completion`] + [`claim_after_review`]. CEI: only
    /// ledger writes (no external call). Self-deal guard widened from Solidity audit Abductive-2 +
    /// Tier-0: when `requester == provider`, escrow still settles, but NONE of the trust signals
    /// (skill rep, totalInvocations, requester rep, provider rep) move.
    ///
    /// T2.1 composition split: if the job's skill has a `Composition` record, the escrow is
    /// distributed across the leaf skills' owners per `weights_bps`. The wrapper owner does
    /// NOT get an implicit slice — if they want a cut they must include one of their OWN
    /// primitive skills as a leaf. Per-leaf reputation + invocation counters and per-leaf-owner
    /// agent rep all bump, mirroring the primitive-skill semantics one level down.
    fn settle_completion(&mut self, j: &mut Job, job_id: u64) {
        j.status = JobStatus::Completed;
        j.completed_at = self.env().get_block_time();

        let composition = self.compositions.get(&j.skill_id);
        let self_deal = j.requester == j.provider;

        if let Some(comp) = composition.as_ref() {
            // ── Composite path: fan out escrow per weights to leaf owners. ──
            //
            // Crediting strategy: we split escrow with integer basis-points math and let the
            // last leaf absorb the rounding remainder, so Σ payouts == escrow_amount exactly.
            // This matches the pull-payment ledger invariant: sum(credited) == debited.
            let escrow = j.escrow_amount;
            let mut distributed = U512::zero();
            let n = comp.leaf_skill_ids.len();
            for (i, leaf_id) in comp.leaf_skill_ids.iter().enumerate() {
                let weight = comp.weights_bps[i];
                // Last leaf gets `escrow - distributed` so rounding never leaves dust behind.
                let payout = if i + 1 == n {
                    escrow - distributed
                } else {
                    let p = (escrow * U512::from(weight)) / U512::from(WEIGHT_DENOMINATOR);
                    distributed += p;
                    p
                };
                let leaf = self.require_skill(*leaf_id);
                let credit = self
                    .pending_withdrawals
                    .get(&leaf.owner)
                    .unwrap_or_default()
                    + payout;
                self.pending_withdrawals.set(&leaf.owner, credit);

                // Leaf reputation bumps mirror the primitive-skill path.
                if !self_deal && j.requester != leaf.owner {
                    let mut leaf_mut = leaf.clone();
                    leaf_mut.total_invocations += 1;
                    let next = leaf_mut.reputation_score.saturating_add(REPUTATION_STEP);
                    leaf_mut.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
                    self.skills.set(leaf_id, leaf_mut);
                    self.bump_agent_rep(leaf.owner);
                }

                self.env().emit_event(CompositionLeafPayout {
                    job_id,
                    composite_skill_id: j.skill_id,
                    leaf_skill_id: *leaf_id,
                    leaf_owner: leaf.owner,
                    payout,
                });
            }

            // Wrapper-level trust signals: composite skill rep + invocation count + wrapper
            // owner agent rep + requester agent rep all move on a successful arm's-length call.
            let mut s = self.require_skill(j.skill_id);
            if !self_deal {
                s.total_invocations += 1;
                let next = s.reputation_score.saturating_add(REPUTATION_STEP);
                s.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
                self.skills.set(&j.skill_id, s.clone());
                self.bump_agent_rep(j.provider);
                self.bump_agent_rep(j.requester);
            }
            self.env().emit_event(JobCompleted {
                job_id,
                provider: j.provider,
                payout: escrow,
                new_reputation: s.reputation_score,
            });
            return;
        }

        // ── Primitive-skill path (unchanged). ──
        let credit =
            self.pending_withdrawals.get(&j.provider).unwrap_or_default() + j.escrow_amount;
        self.pending_withdrawals.set(&j.provider, credit);

        let mut s = self.require_skill(j.skill_id);
        if !self_deal {
            s.total_invocations += 1;
            let next = s.reputation_score.saturating_add(REPUTATION_STEP);
            s.reputation_score = if next > MAX_REPUTATION { MAX_REPUTATION } else { next };
            self.skills.set(&j.skill_id, s.clone());
            self.bump_agent_rep(j.provider);
            self.bump_agent_rep(j.requester);
        }

        self.env().emit_event(JobCompleted {
            job_id,
            provider: j.provider,
            payout: j.escrow_amount,
            new_reputation: s.reputation_score,
        });
    }
}

#[cfg(test)]
mod tests;
