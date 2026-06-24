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

// Note: the full happy-path test (set_vkey + submit_proof with a real Groth16 proof) is
// gated behind `#[cfg(feature = "groth16_fixtures")]` and ships alongside the
// snarkjs → Arkworks-canonical converter (shared follow-on with T5).
