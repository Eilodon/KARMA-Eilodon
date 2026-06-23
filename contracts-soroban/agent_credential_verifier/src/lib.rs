#![no_std]
//! KARMA AgentCredentialProof verifier (Stellar ZK track, T5).
//!
//! Per synthesis §5.4 this contract is a ZK verification layer + minimal job ledger,
//! NOT a full marketplace replacement. Trust gates:
//!   1. Nullifier replay guard — each per-skill nullifier may only be used once.
//!   2. Groth16 proof verification — agent's reputation ≥ skill's threshold without
//!      revealing the actual score (constraints are enforced inside the circuit).
//!   3. (Optional in this commit) x402 receipt — synthesis flow attaches an x402
//!      payment ref as evidence the requester paid the skill price. The receipt
//!      verification itself is delegated to the off-chain x402 facilitator; the
//!      contract just records the reference. Wired in T7 once the Stellar x402
//!      facilitator client is in place.
//!
//! The Groth16 verify uses Arkworks BN254 (no_std, WASM-friendly). When stellar's
//! rs-soroban-env ships native bn254_pairing host functions, `verify_groth16` is
//! the only swap point.

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
    SkillNotFound = 3,
    SkillAlreadyRegistered = 4,
    NullifierReused = 5,
    InvalidProof = 6,
    InvalidVerifyingKey = 7,
    InvalidPublicInputs = 8,
    MalformedBytes = 9,
}

// ── Storage types ───────────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone)]
pub struct SkillConfig {
    pub vkey: Bytes,           // Arkworks-canonical PreparedVerifyingKey<Bn254>
    pub min_reputation: u32,   // the circuit's public minReputation constraint
    pub price_per_call: u128,  // declared cost — informational; settlement via x402/escrow
    pub owner: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct JobRecord {
    pub skill_id: u64,
    pub task_commitment: BytesN<32>,
    pub nullifier: BytesN<32>,
    pub payer: Address,
    pub created_at: u64,
    pub x402_receipt: Bytes,   // facilitator settlement reference (empty when escrow lane)
}

#[contracttype]
enum DataKey {
    Admin,
    JobCounter,
    Skill(u64),
    Nullifier(BytesN<32>),
    Job(u64),
}

// ── Events ──────────────────────────────────────────────────────────────────
// soroban-sdk 26 prefers #[contractevent] structs, but the publish() flow remains correct on
// chain — quieter `#[allow(deprecated)]` keeps the diff small while we ship the verifier; the
// migration to #[contractevent] is a no-behavior-change cleanup tracked separately.
#[allow(deprecated)]
fn event_skill_registered(env: &Env, skill_id: u64, owner: &Address) {
    env.events()
        .publish((Symbol::new(env, "skill_registered"), skill_id), owner.clone());
}
#[allow(deprecated)]
fn event_job_created(env: &Env, job_id: u64, skill_id: u64, payer: &Address) {
    env.events()
        .publish((Symbol::new(env, "job_created"), job_id, skill_id), payer.clone());
}

// ── Contract impl ───────────────────────────────────────────────────────────
#[contract]
pub struct AgentCredentialVerifier;

#[contractimpl]
impl AgentCredentialVerifier {
    /// Initialize the contract with an admin address. Idempotent: re-init reverts.
    pub fn __constructor(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::JobCounter, &0u64);
    }

    /// Register a skill with its verifying-key bytes and trust-gate parameters.
    /// Admin-only — keeps the synthesis §5.4 "not a full marketplace" scope tight.
    /// `vkey` is the Arkworks-canonical serialization of the circuit's PreparedVerifyingKey<Bn254>.
    pub fn register_skill(
        env: Env,
        skill_id: u64,
        vkey: Bytes,
        min_reputation: u32,
        price_per_call: u128,
        owner: Address,
    ) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotAdmin));
        admin.require_auth();
        if env.storage().persistent().has(&DataKey::Skill(skill_id)) {
            panic_with_error!(&env, Error::SkillAlreadyRegistered);
        }
        // Sanity: vkey must deserialize to a real PreparedVerifyingKey before we accept it
        // — fail fast at registration rather than at every create_job. (T8 verifier wire-up.)
        crypto::deserialize_vkey(&vkey).unwrap_or_else(|_| panic_with_error!(&env, Error::InvalidVerifyingKey));
        env.storage().persistent().set(
            &DataKey::Skill(skill_id),
            &SkillConfig { vkey, min_reputation, price_per_call, owner: owner.clone() },
        );
        event_skill_registered(&env, skill_id, &owner);
    }

    /// Create a job: verify the AgentCredentialProof, claim the nullifier, store the job record.
    /// `public_inputs` MUST be the 5-element vector the circuit produces:
    ///   [ skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot ]
    /// in that exact order (asserted by circuits/test/agent_credential.test.mjs).
    pub fn create_job(
        env: Env,
        payer: Address,
        skill_id: u64,
        task_commitment: BytesN<32>,
        proof: Bytes,
        nullifier: BytesN<32>,
        public_inputs: Vec<BytesN<32>>,
        x402_receipt: Bytes,
    ) -> u64 {
        payer.require_auth();

        // 1. Nullifier replay guard — `nullifier` is per-skill, so a tampered skill_id would
        //    produce a different nullifier, breaking the circuit constraint at verify time.
        if env.storage().persistent().has(&DataKey::Nullifier(nullifier.clone())) {
            panic_with_error!(&env, Error::NullifierReused);
        }

        // 2. Look up the skill's verifying key + trust-gate parameters.
        let skill: SkillConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Skill(skill_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::SkillNotFound));

        // 3. Verify the proof binds to (skill_id, min_reputation, nullifier) by comparing the
        //    contract-known public inputs against what the proof committed to.
        if public_inputs.len() != 5 {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        // Element 0: skillId. Element 1: minReputation. Element 2: nullifier.
        let pi_skill = public_inputs.get(0).unwrap();
        let pi_min_rep = public_inputs.get(1).unwrap();
        let pi_nullifier = public_inputs.get(2).unwrap();
        if !crypto::bytes32_equals_u64(&env, &pi_skill, skill_id) {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        if !crypto::bytes32_equals_u32(&env, &pi_min_rep, skill.min_reputation) {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }
        if pi_nullifier != nullifier {
            panic_with_error!(&env, Error::InvalidPublicInputs);
        }

        // 4. Groth16 pairing check — the load-bearing crypto step.
        let ok = crypto::verify_groth16(&skill.vkey, &proof, &public_inputs);
        if !ok {
            panic_with_error!(&env, Error::InvalidProof);
        }

        // 5. Effects: claim nullifier, mint job id, record job.
        env.storage().persistent().set(&DataKey::Nullifier(nullifier.clone()), &true);
        let job_id: u64 = env.storage().instance().get(&DataKey::JobCounter).unwrap_or(0) + 1;
        env.storage().instance().set(&DataKey::JobCounter, &job_id);
        env.storage().persistent().set(
            &DataKey::Job(job_id),
            &JobRecord {
                skill_id,
                task_commitment,
                nullifier,
                payer: payer.clone(),
                created_at: env.ledger().timestamp(),
                x402_receipt,
            },
        );
        event_job_created(&env, job_id, skill_id, &payer);
        job_id
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    pub fn get_skill(env: Env, skill_id: u64) -> Option<SkillConfig> {
        env.storage().persistent().get(&DataKey::Skill(skill_id))
    }

    pub fn get_job(env: Env, job_id: u64) -> Option<JobRecord> {
        env.storage().persistent().get(&DataKey::Job(job_id))
    }

    pub fn job_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::JobCounter).unwrap_or(0)
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
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
            let raw = bytesn_to_array(&b);
            match Fr::deserialize_compressed(raw.as_slice()) {
                Ok(fr) => fr_inputs.push(fr),
                Err(_) => return false,
            }
        }
        Groth16::<Bn254>::verify_proof(&pvk, &proof, &fr_inputs).unwrap_or(false)
    }

    /// True iff `b` (little-endian field element bytes) equals the given u64.
    pub(super) fn bytes32_equals_u64(_env: &Env, b: &BytesN<32>, v: u64) -> bool {
        let raw = bytesn_to_array(b);
        // Lower 8 bytes carry the value; upper 24 bytes must be zero.
        let mut le8 = [0u8; 8];
        le8.copy_from_slice(&raw[0..8]);
        let lo = u64::from_le_bytes(le8);
        let upper_zero = raw[8..32].iter().all(|x| *x == 0);
        lo == v && upper_zero
    }

    pub(super) fn bytes32_equals_u32(_env: &Env, b: &BytesN<32>, v: u32) -> bool {
        let raw = bytesn_to_array(b);
        let mut le4 = [0u8; 4];
        le4.copy_from_slice(&raw[0..4]);
        let lo = u32::from_le_bytes(le4);
        let upper_zero = raw[4..32].iter().all(|x| *x == 0);
        lo == v && upper_zero
    }

    fn bytes_to_vec(b: &Bytes) -> StdVec<u8> {
        let len = b.len() as usize;
        let mut out = StdVec::with_capacity(len);
        for i in 0..b.len() {
            out.push(b.get(i).unwrap());
        }
        out
    }

    fn bytesn_to_array(b: &BytesN<32>) -> [u8; 32] {
        b.to_array()
    }
}

#[cfg(test)]
mod test;
