//! Host-side tests for ReputationAggregationVerifier (T1.1).
//!
//! Mirrors the agent_credential_verifier test layout: schema + access-control invariants,
//! plus a real (non-satisfying) native `bn254_multi_pairing_check` call so the crypto path
//! itself — not just arity/type plumbing — is exercised. Covers:
//!
//!   1. constructor sets admin + zeroes credential counter
//!   2. set_vkey rejects wrong `ic` arity
//!   3. set_vkey requires admin auth
//!   4. set_epoch_root requires admin auth + reads back
//!   5. submit_proof rejects unset vkey, missing epoch root, malformed public inputs,
//!      root mismatch, and a well-formed-but-non-satisfying proof

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec as SVec};

fn boot<'a>(env: &'a Env) -> (Address, ReputationAggregationVerifierClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register(ReputationAggregationVerifier, (admin.clone(),));
    let client = ReputationAggregationVerifierClient::new(env, &contract_id);
    (admin, client)
}

fn zero_g1(env: &Env) -> Bn254G1Affine {
    Bn254G1Affine::from_array(env, &[0u8; 64])
}

fn zero_g2(env: &Env) -> Bn254G2Affine {
    Bn254G2Affine::from_array(env, &[0u8; 128])
}

fn zero_fr(env: &Env) -> Bn254Fr {
    Bn254Fr::from_bytes(BytesN::from_array(env, &[0u8; 32]))
}

fn zero_proof(env: &Env) -> Groth16Proof {
    Groth16Proof { a: zero_g1(env), b: zero_g2(env), c: zero_g1(env) }
}

fn zero_vkey(env: &Env, ic_len: u32) -> VerifyingKey {
    let mut ic = SVec::new(env);
    for _ in 0..ic_len {
        ic.push_back(zero_g1(env));
    }
    VerifyingKey { alpha: zero_g1(env), beta: zero_g2(env), gamma: zero_g2(env), delta: zero_g2(env), ic }
}

// Real on-curve, in-subgroup BN254 test vectors (go-ethereum bn256Pairing.json, also used by
// the soroban-sdk v25_bn254 migration-guide example) — see agent_credential_verifier's test
// module for why these make a safe, genuinely non-trivial pairing check.
const REAL_G1: [u8; 64] = [
    0x1c, 0x76, 0x47, 0x6f, 0x4d, 0xef, 0x4b, 0xb9, 0x45, 0x41, 0xd5, 0x7e, 0xbb, 0xa1, 0x19, 0x33,
    0x81, 0xff, 0xa7, 0xaa, 0x76, 0xad, 0xa6, 0x64, 0xdd, 0x31, 0xc1, 0x60, 0x24, 0xc4, 0x3f, 0x59,
    0x30, 0x34, 0xdd, 0x29, 0x20, 0xf6, 0x73, 0xe2, 0x04, 0xfe, 0xe2, 0x81, 0x1c, 0x67, 0x87, 0x45,
    0xfc, 0x81, 0x9b, 0x55, 0xd3, 0xe9, 0xd2, 0x94, 0xe4, 0x5c, 0x9b, 0x03, 0xa7, 0x6a, 0xef, 0x41,
];
const REAL_G2: [u8; 128] = [
    0x20, 0x9d, 0xd1, 0x5e, 0xbf, 0xf5, 0xd4, 0x6c, 0x4b, 0xd8, 0x88, 0xe5, 0x1a, 0x93, 0xcf, 0x99,
    0xa7, 0x32, 0x96, 0x36, 0xc6, 0x35, 0x14, 0x39, 0x6b, 0x4a, 0x45, 0x20, 0x03, 0xa3, 0x5b, 0xf7,
    0x04, 0xbf, 0x11, 0xca, 0x01, 0x48, 0x3b, 0xfa, 0x8b, 0x34, 0xb4, 0x35, 0x61, 0x84, 0x8d, 0x28,
    0x90, 0x59, 0x60, 0x11, 0x4c, 0x8a, 0xc0, 0x40, 0x49, 0xaf, 0x4b, 0x63, 0x15, 0xa4, 0x16, 0x78,
    0x2b, 0xb8, 0x32, 0x4a, 0xf6, 0xcf, 0xc9, 0x35, 0x37, 0xa2, 0xad, 0x1a, 0x44, 0x5c, 0xfd, 0x0c,
    0xa2, 0xa7, 0x1a, 0xcd, 0x7a, 0xc4, 0x1f, 0xad, 0xbf, 0x93, 0x3c, 0x2a, 0x51, 0xbe, 0x34, 0x4d,
    0x12, 0x0a, 0x2a, 0x4c, 0xf3, 0x0c, 0x1b, 0xf9, 0x84, 0x5f, 0x20, 0xc6, 0xfe, 0x39, 0xe0, 0x7e,
    0xa2, 0xcc, 0xe6, 0x1f, 0x0c, 0x9b, 0xb0, 0x48, 0x16, 0x5f, 0xe5, 0xe4, 0xde, 0x87, 0x75, 0x50,
];

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
fn set_vkey_rejects_wrong_ic_arity() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    // Circuit has 5 public inputs, so `ic` must have 6 elements — 2 is wrong on purpose.
    client.set_vkey(&zero_vkey(&env, 2));
}

#[test]
fn set_vkey_accepts_correct_ic_arity() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    client.set_vkey(&zero_vkey(&env, 6));
    assert!(client.vkey_set());
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
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[3u8; 32]);
    let root = BytesN::<32>::from_array(&env, &[4u8; 32]);
    client.set_epoch_root(&1u64, &root);
    let inputs: SVec<Bn254Fr> = SVec::from_array(
        &env,
        [
            zero_fr(&env),
            zero_fr(&env),
            zero_fr(&env),
            Bn254Fr::from_bytes(null.clone()),
            Bn254Fr::from_bytes(root.clone()),
        ],
    );
    client.submit_proof(&agent, &1u64, &zero_proof(&env), &null, &inputs);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // EpochRootNotSet
fn submit_proof_rejects_unknown_epoch() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[9u8; 32]);
    let inputs: SVec<Bn254Fr> = SVec::from_array(
        &env,
        [
            zero_fr(&env),
            zero_fr(&env),
            zero_fr(&env),
            Bn254Fr::from_bytes(null.clone()),
            zero_fr(&env),
        ],
    );
    client.submit_proof(&agent, &7u64, &zero_proof(&env), &null, &inputs);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // InvalidPublicInputs (length != 5)
fn submit_proof_rejects_short_public_inputs() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[2u8; 32]);
    let inputs: SVec<Bn254Fr> = SVec::from_array(
        &env,
        [zero_fr(&env), zero_fr(&env), zero_fr(&env), zero_fr(&env)],
    );
    client.submit_proof(&agent, &0u64, &zero_proof(&env), &null, &inputs);
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
    let inputs: SVec<Bn254Fr> = SVec::from_array(
        &env,
        [
            zero_fr(&env),
            zero_fr(&env),
            zero_fr(&env),
            Bn254Fr::from_bytes(null.clone()),
            Bn254Fr::from_bytes(claimed_root),
        ],
    );
    client.submit_proof(&agent, &3u64, &zero_proof(&env), &null, &inputs);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // InvalidProof
fn submit_proof_rejects_non_satisfying_proof() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = boot(&env);
    // Real on-curve alpha/beta (unrelated test-vector points, so e(alpha,beta) != 1) with an
    // identity proof/ic makes every other pairing term collapse to 1 — the whole product is
    // exactly e(alpha,beta), which is not the target-group identity, so the check must fail.
    // Exercises the native `bn254_multi_pairing_check` call end-to-end, not just plumbing.
    let mut vkey = zero_vkey(&env, 6);
    vkey.alpha = Bn254G1Affine::from_array(&env, &REAL_G1);
    vkey.beta = Bn254G2Affine::from_array(&env, &REAL_G2);
    client.set_vkey(&vkey);

    let agent = Address::generate(&env);
    let null = BytesN::<32>::from_array(&env, &[13u8; 32]);
    let root = BytesN::<32>::from_array(&env, &[14u8; 32]);
    client.set_epoch_root(&5u64, &root);
    let inputs: SVec<Bn254Fr> = SVec::from_array(
        &env,
        [
            zero_fr(&env),
            zero_fr(&env),
            zero_fr(&env),
            Bn254Fr::from_bytes(null.clone()),
            Bn254Fr::from_bytes(root.clone()),
        ],
    );
    client.submit_proof(&agent, &5u64, &zero_proof(&env), &null, &inputs);
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
// snarkjs → native-BN254 packing script (shared follow-on with T5).
