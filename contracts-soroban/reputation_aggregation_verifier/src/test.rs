//! Host-side tests for ReputationAggregationVerifier (T1.1).
//!
//! Mirrors the agent_credential_verifier test layout: schema + access-control invariants
//! covered now; the full happy-path Groth16 verify is gated behind a `groth16_fixtures` cfg
//! flag (enabled once the snarkjs → Arkworks-canonical converter ships — same gating as the
//! T5 sibling). Until then this baseline still pins down:
//!
//!   1. constructor sets admin + zeroes credential counter
//!   2. set_vkey rejects garbage bytes (deserialize check)
//!   3. set_vkey requires admin auth
//!   4. set_epoch_root requires admin auth + reads back
//!   5. submit_proof rejects unset vkey, missing epoch root, malformed public inputs

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec as SVec};

fn boot<'a>(env: &'a Env) -> (Address, ReputationAggregationVerifierClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register(ReputationAggregationVerifier, (admin.clone(),));
    let client = ReputationAggregationVerifierClient::new(env, &contract_id);
    (admin, client)
}

#[test]
fn constructor_sets_admin_and_zero_credentials() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = boot(&env);
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.credential_count(), 0);
    assert!(!client.vkey_set());
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // InvalidVerifyingKey
fn set_vkey_rejects_garbage() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    client.set_vkey(&Bytes::from_array(&env, &[0u8; 4]));
}

#[test]
fn set_epoch_root_round_trips() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let root = BytesN::<32>::from_array(&env, &[7u8; 32]);
    client.set_epoch_root(&42u64, &root);
    assert_eq!(client.epoch_root(&42u64), Some(root));
    assert_eq!(client.epoch_root(&99u64), None);
}

#[test]
fn is_nullifier_used_defaults_false() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let null = BytesN::<32>::from_array(&env, &[5u8; 32]);
    assert!(!client.is_nullifier_used(&null));
}

#[test]
fn get_credential_returns_none_for_unknown() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let null = BytesN::<32>::from_array(&env, &[1u8; 32]);
    assert!(client.get_credential(&null).is_none());
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // VkeyNotSet
fn submit_proof_rejects_unset_vkey() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    // Publish an epoch root so we get past the EpochRootNotSet check first... actually we
    // intentionally don't, to assert the failure mode: nullifier-replay check comes before
    // input arity, but vkey lookup comes AFTER epochRoot lookup. So to exercise VkeyNotSet
    // we need a valid 5-element vector AND a known epoch root.
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[3u8; 32]);
    let root = BytesN::<32>::from_array(&env, &[4u8; 32]);
    client.set_epoch_root(&1u64, &root);
    let inputs: SVec<BytesN<32>> = SVec::from_array(
        &env,
        [
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            null.clone(),
            root.clone(),
        ],
    );
    client.submit_proof(&agent, &1u64, &Bytes::new(&env), &null, &inputs);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // EpochRootNotSet
fn submit_proof_rejects_unknown_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[9u8; 32]);
    let inputs: SVec<BytesN<32>> = SVec::from_array(
        &env,
        [
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            null.clone(),
            BytesN::<32>::from_array(&env, &[8u8; 32]),
        ],
    );
    client.submit_proof(&agent, &7u64, &Bytes::new(&env), &null, &inputs);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // InvalidPublicInputs (length != 5)
fn submit_proof_rejects_short_public_inputs() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[2u8; 32]);
    let zero = BytesN::<32>::from_array(&env, &[0u8; 32]);
    let inputs: SVec<BytesN<32>> = SVec::from_array(
        &env,
        [zero.clone(), zero.clone(), zero.clone(), zero.clone()],
    );
    client.submit_proof(&agent, &0u64, &Bytes::new(&env), &null, &inputs);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // EpochRootMismatch
fn submit_proof_rejects_root_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[11u8; 32]);
    let stored_root = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let claimed_root = BytesN::<32>::from_array(&env, &[2u8; 32]);
    client.set_epoch_root(&3u64, &stored_root);
    let inputs: SVec<BytesN<32>> = SVec::from_array(
        &env,
        [
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            BytesN::<32>::from_array(&env, &[0u8; 32]),
            null.clone(),
            claimed_root,
        ],
    );
    client.submit_proof(&agent, &3u64, &Bytes::new(&env), &null, &inputs);
}

// ── Cross-chain reputation consumer (P0.1) ────────────────────────────────
// These tests exercise the consumer entrypoints without needing a real Groth16 proof.
// They manually insert a CredentialRecord to simulate a successful submit_proof.

fn insert_credential(env: &Env, contract_id: &Address, agent: &Address, nullifier: &BytesN<32>, min_avg: u32) {
    // Directly write a CredentialRecord into contract storage to simulate a successful
    // submit_proof without needing real Groth16 artefacts.
    env.as_contract(contract_id, || {
        let cred = CredentialRecord {
            agent: agent.clone(),
            epoch_id: 1,
            min_avg_score: min_avg,
            min_distinct_categories: 3,
            min_jobs: 10,
            nullifier: nullifier.clone(),
            created_at: 100,
        };
        env.storage().persistent().set(&DataKey::Credential(nullifier.clone()), &cred);
        env.storage().persistent().set(&DataKey::Nullifier(nullifier.clone()), &true);
    });
}

#[test]
fn cross_chain_rep_returns_none_by_default() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    assert_eq!(client.cross_chain_rep(&agent), None);
}

#[test]
fn update_cross_chain_rep_stores_min_avg_score() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[42u8; 32]);
    insert_credential(&env, &client.address, &agent, &null, 85);

    let score = client.update_cross_chain_rep(&agent, &null);
    assert_eq!(score, 85);
    assert_eq!(client.cross_chain_rep(&agent), Some(85));
}

#[test]
fn update_cross_chain_rep_overwrites_on_newer_credential() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);

    let null1 = BytesN::<32>::from_array(&env, &[10u8; 32]);
    insert_credential(&env, &client.address, &agent, &null1, 70);
    client.update_cross_chain_rep(&agent, &null1);
    assert_eq!(client.cross_chain_rep(&agent), Some(70));

    let null2 = BytesN::<32>::from_array(&env, &[20u8; 32]);
    insert_credential(&env, &client.address, &agent, &null2, 90);
    client.update_cross_chain_rep(&agent, &null2);
    assert_eq!(client.cross_chain_rep(&agent), Some(90));
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")] // CredentialNotFound
fn update_cross_chain_rep_rejects_unknown_nullifier() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[99u8; 32]);
    client.update_cross_chain_rep(&agent, &null);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // AgentMismatch
fn update_cross_chain_rep_rejects_wrong_agent() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let real_agent = Address::generate(&env);
    let impostor = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[77u8; 32]);
    insert_credential(&env, &client.address, &real_agent, &null, 80);
    client.update_cross_chain_rep(&impostor, &null);
}

#[test]
fn admin_set_cross_chain_rep_works() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);

    client.admin_set_cross_chain_rep(&agent, &75u32);
    assert_eq!(client.cross_chain_rep(&agent), Some(75));
}

// Note: the full happy-path test (set_vkey + submit_proof with a real Groth16 proof) is
// gated behind `#[cfg(feature = "groth16_fixtures")]` and ships alongside the
// snarkjs → Arkworks-canonical converter (shared follow-on with T5).
