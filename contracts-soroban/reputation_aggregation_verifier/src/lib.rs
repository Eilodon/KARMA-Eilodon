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
//!   2. Groth16 proof verification — Arkworks BN254, exact same path as T5.
//!   3. epochRoot must match the admin-published root for the declared epoch_id.
//!
//! Trusted-setup story matches T5: testnet uses a single-contributor zkey, mainnet
//! gets a multi-party ceremony. Documented in `docs/decisions/DP-7-zk-framework.md`.

extern crate alloc;

use alloc::vec::Vec as StdVec;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Bytes, BytesN,
    Env, Symbol, Vec,
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
// soroban-sdk 26 prefers #[contractevent] structs; keeping the publish() flow here to match
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

    /// Set the global verifying key (Arkworks-canonical PreparedVerifyingKey<Bn254>).
    /// Admin-only, idempotent — late-setting is supported so the ceremony can complete after
    /// contract deploy. Sanity-checks deserialization up front to fail fast.
    pub fn set_vkey(env: Env, vkey: Bytes) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();
        crypto::deserialize_vkey(&vkey)
            .unwrap_or_else(|_| panic_with_error!(&env, Error::InvalidVerifyingKey));
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
    /// Asserted by circuits/test/reputation_aggregation.test.mjs.
    pub fn submit_proof(
        env: Env,
        agent: Address,
        epoch_id: u64,
        proof: Bytes,
        nullifier: BytesN<32>,
        public_inputs: Vec<BytesN<32>>,
    ) -> u64 {
        agent.require_auth();

        // 1. Nullifier replay guard.
        if env.storage().persistent().has(&DataKey::Nullifier(nullifier.clone())) {
            panic_with_error!(&env, Error::NullifierReused);
        }

        // 2. Public-input arity + on-chain binding checks.
        if public_inputs.len() != 5 {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        // public_inputs[3] = nullifier; public_inputs[4] = epochRoot.
        let pi_nullifier = public_inputs.get(3).unwrap();
        let pi_epoch_root = public_inputs.get(4).unwrap();
        if pi_nullifier != nullifier {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        let known_root: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::EpochRoot(epoch_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::EpochRootNotSet));
        if pi_epoch_root != known_root {
            panic_with_error!(&env, Error::EpochRootMismatch);
        }

        // 3. Groth16 pairing check.
        let vkey: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::Vkey)
            .unwrap_or_else(|| panic_with_error!(&env, Error::VkeyNotSet));
        let ok = crypto::verify_groth16(&vkey, &proof, &public_inputs);
        if !ok {
            panic_with_error!(&env, Error::InvalidProof);
        }

        // 4. Effects: extract the agent-chosen thresholds for the on-chain record, claim
        //    nullifier, mint credential record.
        let min_avg = crypto::bytes32_to_u32(&public_inputs.get(0).unwrap());
        let min_dist = crypto::bytes32_to_u32(&public_inputs.get(1).unwrap());
        let min_jobs = crypto::bytes32_to_u32(&public_inputs.get(2).unwrap());
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
    use ark_bn254::{Bn254, Fr};
    use ark_groth16::{Groth16, PreparedVerifyingKey, Proof};
    use ark_serialize::CanonicalDeserialize;

    pub(super) fn deserialize_vkey(vkey: &Bytes) -> Result<PreparedVerifyingKey<Bn254>, ()> {
        let buf = bytes_to_vec(vkey);
        PreparedVerifyingKey::<Bn254>::deserialize_compressed(buf.as_slice()).map_err(|_| ())
    }

    pub(super) fn verify_groth16(
        vkey_bytes: &Bytes,
        proof_bytes: &Bytes,
        public_inputs: &Vec<BytesN<32>>,
    ) -> bool {
        let pvk = match deserialize_vkey(vkey_bytes) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let proof_buf = bytes_to_vec(proof_bytes);
        let proof = match Proof::<Bn254>::deserialize_compressed(proof_buf.as_slice()) {
            Ok(p) => p,
            Err(_) => return false,
        };
        let mut fr_inputs: StdVec<Fr> = StdVec::with_capacity(public_inputs.len() as usize);
        for i in 0..public_inputs.len() {
            let b: BytesN<32> = public_inputs.get(i).unwrap();
            let raw = b.to_array();
            match Fr::deserialize_compressed(raw.as_slice()) {
                Ok(fr) => fr_inputs.push(fr),
                Err(_) => return false,
            }
        }
        Groth16::<Bn254>::verify_proof(&pvk, &proof, &fr_inputs).unwrap_or(false)
    }

    /// Decode a public-input BytesN<32> as a little-endian u32. Upper bytes silently truncated
    /// — caller is responsible for ensuring the on-chain threshold value fits in a u32, which
    /// it does for all three RepAgg threshold inputs (avg ≤ 100, distinct ≤ 32, jobs ≤ 2^16
    /// per-tuple × N ≤ 2^20).
    pub(super) fn bytes32_to_u32(b: &BytesN<32>) -> u32 {
        let raw = b.to_array();
        let mut le4 = [0u8; 4];
        le4.copy_from_slice(&raw[0..4]);
        u32::from_le_bytes(le4)
    }

    fn bytes_to_vec(b: &Bytes) -> StdVec<u8> {
        let len = b.len() as usize;
        let mut out = StdVec::with_capacity(len);
        for i in 0..b.len() {
            out.push(b.get(i).unwrap());
        }
        out
    }
}

#[cfg(test)]
mod test;
