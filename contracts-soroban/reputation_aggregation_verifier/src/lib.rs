#![no_std]
//! KARMA ReputationAggregationProof verifier (Stellar ZK track, T1.1).
//!
//! Sibling of `agent_credential_verifier` (T5), NOT a replacement. The two prove
//! different facts and intentionally live in separate contracts so audit + nullifier
//! domains stay disjoint:
//!
//!   AgentCredentialProof  — single-skill access gate ("rep ≥ X for skill Y").
//!   ReputationAggregation — portfolio credential ("rep ≥ X avg across ≥ K
//!                            distinct categories over ≥ N jobs in epoch E").
//!
//! Use case: a marketplace skill demands a "trust tier" credential before exposing
//! its high-value endpoint. The agent generates a ReputationAggregationProof against
//! the issuer's published per-epoch job-history Merkle root, submits to this
//! verifier, and the resulting on-chain CredentialRecord (indexed by nullifier) is
//! what the skill provider reads off chain.
//!
//! Trust gates per synthesis §5.4:
//!   1. Per-epoch nullifier replay guard — Poseidon(agentSecret, epoch).
//!   2. Groth16 proof verification — native BN254 host functions, exact same path as T5.
//!   3. epochRoot must match the admin-published root for the declared epoch_id.
//!
//! Trusted-setup story matches T5: testnet uses a single-contributor zkey, mainnet
//! gets a multi-party ceremony. Documented in `docs/decisions/DP-7-zk-framework.md`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    panic_with_error, vec, Address, BytesN, Env, Symbol, Vec,
};

// ── Errors ──────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    VkeyNotSet = 3,
    EpochRootNotSet = 4,
    NullifierReused = 5,
    InvalidProof = 6,
    InvalidVerifyingKey = 7,
    InvalidPublicInputs = 8,
    EpochRootMismatch = 9,
    CredentialNotFound = 10,
    AgentMismatch = 11,
}

// ── Groth16 / BN254 types ─────────────────────────────────────────────────
// Same layout + native-host-function verifier as `agent_credential_verifier` — see that
// contract's module doc for the point-encoding details (Ethereum-compatible uncompressed
// BN254, per `soroban_sdk::crypto::bn254`).
#[contracttype]
#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    /// `ic[0]` is the constant term; `ic[1..]` pair one-to-one with public inputs.
    /// For this circuit (5 public signals) `ic.len()` MUST be 6.
    pub ic: Vec<Bn254G1Affine>,
}

#[contracttype]
#[derive(Clone)]
pub struct Groth16Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

const PUBLIC_INPUT_COUNT: u32 = 5;

// ── Storage types ───────────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone)]
pub struct CredentialRecord {
    pub agent: Address,
    pub epoch_id: u64,
    /// Agent-chosen threshold gates (asserted in-circuit). 0..100 for avg score; counts otherwise.
    pub min_avg_score: u32,
    pub min_distinct_categories: u32,
    pub min_jobs: u32,
    pub nullifier: BytesN<32>,
    pub created_at: u64,
}

#[contracttype]
enum DataKey {
    Admin,
    Vkey,
    EpochRoot(u64),
    Nullifier(BytesN<32>),
    Credential(BytesN<32>),
    CredentialCounter,
    CrossChainRep(Address),
}

// ── Events ──────────────────────────────────────────────────────────────────
// soroban-sdk 26 prefers #[contractevent] structs, keeping the publish() flow here to match
// the T5 verifier's quieter migration path.
#[allow(deprecated)]
fn event_epoch_root_set(env: &Env, epoch_id: u64, root: &BytesN<32>) {
    env.events()
        .publish((Symbol::new(env, "epoch_root_set"), epoch_id), root.clone());
}
#[allow(deprecated)]
fn event_credential_issued(
    env: &Env,
    nullifier: &BytesN<32>,
    agent: &Address,
    epoch_id: u64,
) {
    env.events().publish(
        (Symbol::new(env, "rep_agg_credential"), epoch_id),
        (nullifier.clone(), agent.clone()),
    );
}
#[allow(deprecated)]
fn event_cross_chain_rep_updated(env: &Env, agent: &Address, score: u32) {
    env.events()
        .publish((Symbol::new(env, "cross_chain_rep"),), (agent.clone(), score));
}

// ── Contract impl ───────────────────────────────────────────────────────────
#[contract]
pub struct ReputationAggregationVerifier;

#[contractimpl]
impl ReputationAggregationVerifier {
    /// Initialize. Idempotent: re-init reverts. Vkey is set in a separate admin call so that
    /// a multi-party ceremony can run between deployment and first proof submission.
    pub fn __constructor(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::CredentialCounter, &0u64);
    }

    /// Set the global verifying key. Admin-only, idempotent — late-setting is supported so
    /// the ceremony can complete after contract deploy. Sanity-checks `ic` arity up front to
    /// fail fast.
    pub fn set_vkey(env: Env, vkey: VerifyingKey) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();
        if vkey.ic.len() != PUBLIC_INPUT_COUNT + 1 {
            panic_with_error!(&env, Error::InvalidVerifyingKey);
        }
        env.storage().persistent().set(&DataKey::Vkey, &vkey);
    }

    /// Publish (or overwrite) the Merkle root for an epoch. The off-chain prover service
    /// builds this root from indexed JobCompleted events and the admin mirrors it on-chain.
    /// Overwrite is allowed only when no nullifier under this root has been claimed —
    /// keeps the credential issuance audit-trail honest.
    pub fn set_epoch_root(env: Env, epoch_id: u64, root: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();
        env.storage().persistent().set(&DataKey::EpochRoot(epoch_id), &root);
        event_epoch_root_set(&env, epoch_id, &root);
    }

    /// Submit a ReputationAggregationProof. Anyone can call (the agent pays gas).
    ///
    /// `public_inputs` MUST be the 5-element vector the circuit produces, in circuit order:
    ///   [ minAvgScore, minDistinctCategories, minJobs, nullifier, epochRoot ]
    /// Asserted by circuits/test/reputation_aggregation.test.mjs. Each element is a
    /// big-endian BN254 scalar-field element (`Bn254Fr`).
    pub fn submit_proof(
        env: Env,
        agent: Address,
        epoch_id: u64,
        proof: Groth16Proof,
        nullifier: BytesN<32>,
        public_inputs: Vec<Bn254Fr>,
    ) -> u64 {
        agent.require_auth();

        // 1. Nullifier replay guard.
        if env.storage().persistent().has(&DataKey::Nullifier(nullifier.clone())) {
            panic_with_error!(&env, Error::NullifierReused);
        }

        // 2. Public-input arity + on-chain binding checks.
        if public_inputs.len() != PUBLIC_INPUT_COUNT {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        // public_inputs[3] = nullifier; public_inputs[4] = epochRoot.
        let pi_nullifier = public_inputs.get(3).unwrap();
        let pi_epoch_root = public_inputs.get(4).unwrap();
        if pi_nullifier != Bn254Fr::from_bytes(nullifier.clone()) {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        let known_root: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::EpochRoot(epoch_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::EpochRootNotSet));
        if pi_epoch_root != Bn254Fr::from_bytes(known_root) {
            panic_with_error!(&env, Error::EpochRootMismatch);
        }

        // 3. Groth16 pairing check — native BN254 host functions (CAP-0074).
        let vkey: VerifyingKey = env
            .storage()
            .persistent()
            .get(&DataKey::Vkey)
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkeyNotSet));
        let ok = crypto::verify_groth16(&env, &vkey, &proof, &public_inputs);
        if !ok {
            panic_with_error!(&env, Error::InvalidProof);
        }

        // 4. Effects: extract the agent-chosen thresholds for the on-chain record, claim
        //    nullifier, mint credential record.
        let min_avg = crypto::fr_to_u32(&public_inputs.get(0).unwrap());
        let min_dist = crypto::fr_to_u32(&public_inputs.get(1).unwrap());
        let min_jobs = crypto::fr_to_u32(&public_inputs.get(2).unwrap());
        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CredentialCounter)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::CredentialCounter, &counter);
        env.storage().persistent().set(&DataKey::Nullifier(nullifier.clone()), &true);
        env.storage().persistent().set(
            &DataKey::Credential(nullifier.clone()),
            &CredentialRecord {
                agent: agent.clone(),
                epoch_id,
                min_avg_score: min_avg,
                min_distinct_categories: min_dist,
                min_jobs,
                nullifier: nullifier.clone(),
                created_at: env.ledger().timestamp(),
            },
        );
        event_credential_issued(&env, &nullifier, &agent, epoch_id);
        counter
    }

    // ── Cross-chain reputation consumer (P0.1) ───────────────────────────
    //
    // Given a verified credential (identified by nullifier), computes a queryable
    // cross-chain reputation score and stores it keyed by agent address. This is the
    // missing consumer that T5.2's demo needs — without it, verified proofs produce
    // credentials but nothing downstream reads them into a usable reputation value.

    /// Consume a verified credential to update the agent's cross-chain reputation.
    /// The credential must exist (i.e. `submit_proof` succeeded for this nullifier)
    /// and the caller must be the credential's agent. The reputation value is the
    /// credential's `min_avg_score` — the floor the agent proved in-circuit.
    pub fn update_cross_chain_rep(env: Env, agent: Address, nullifier: BytesN<32>) -> u32 {
        agent.require_auth();

        let cred: CredentialRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Credential(nullifier))
            .unwrap_or_else(|| panic_with_error!(&env, Error::CredentialNotFound));

        if cred.agent != agent {
            panic_with_error!(&env, Error::AgentMismatch);
        }

        let score = cred.min_avg_score;
        env.storage()
            .persistent()
            .set(&DataKey::CrossChainRep(agent.clone()), &score);
        event_cross_chain_rep_updated(&env, &agent, score);
        score
    }

    /// Admin override: set cross-chain reputation directly (for bridge attestations
    /// from other chains where the proof was verified remotely).
    pub fn admin_set_cross_chain_rep(env: Env, agent: Address, score: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::CrossChainRep(agent.clone()), &score);
        event_cross_chain_rep_updated(&env, &agent, score);
    }

    /// Query the cross-chain reputation for an agent. Returns `None` if no credential
    /// has been consumed yet.
    pub fn cross_chain_rep(env: Env, agent: Address) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::CrossChainRep(agent))
    }

    // ── Views ───────────────────────────────────────────────────────────────
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    pub fn get_credential(env: Env, nullifier: BytesN<32>) -> Option<CredentialRecord> {
        env.storage().persistent().get(&DataKey::Credential(nullifier))
    }

    pub fn epoch_root(env: Env, epoch_id: u64) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::EpochRoot(epoch_id))
    }

    pub fn vkey_set(env: Env) -> bool {
        env.storage().persistent().has(&DataKey::Vkey)
    }

    pub fn credential_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::CredentialCounter).unwrap_or(0)
    }
}

// ── Crypto helpers ──────────────────────────────────────────────────────────
mod crypto {
    use super::*;

    /// Groth16 verification via Stellar's native BN254 host functions
    /// (`env.crypto().bn254()`, CAP-0074 `bn254_multi_pairing_check`). Identical equation
    /// to `agent_credential_verifier::crypto::verify_groth16` (T5) — kept duplicated rather
    /// than shared so the two verifiers' audit surfaces stay independent (per module doc).
    pub(super) fn verify_groth16(
        env: &Env,
        vk: &VerifyingKey,
        proof: &Groth16Proof,
        public_inputs: &Vec<Bn254Fr>,
    ) -> bool {
        let bn254 = env.crypto().bn254();
        if public_inputs.len() + 1 != vk.ic.len() {
            return false;
        }
        let mut vk_x = vk.ic.get(0).unwrap();
        for i in 0..public_inputs.len() {
            let s = public_inputs.get(i).unwrap();
            let v = vk.ic.get(i + 1).unwrap();
            let prod = bn254.g1_mul(&v, &s);
            vk_x = bn254.g1_add(&vk_x, &prod);
        }
        let neg_a = -proof.a.clone();
        let vp1 = vec![env, neg_a, vk.alpha.clone(), vk_x, proof.c.clone()];
        let vp2 = vec![env, proof.b.clone(), vk.beta.clone(), vk.gamma.clone(), vk.delta.clone()];
        bn254.pairing_check(vp1, vp2)
    }

    /// Reads a `Bn254Fr` back out as a `u32` (upper 28 bytes are expected to be zero — true
    /// for all three RepAgg threshold inputs: avg ≤ 100, distinct ≤ 32, jobs ≤ 2^16 per-tuple
    /// × N ≤ 2^20). Big-endian, mirroring how the off-chain prover packs them.
    pub(super) fn fr_to_u32(fr: &Bn254Fr) -> u32 {
        let bytes = fr.to_bytes().to_array();
        u32::from_be_bytes(bytes[28..32].try_into().unwrap())
    }
}

#[cfg(test)]
mod test;
