# `agent_credential_verifier` — Soroban verifier contract (T5)

KARMA's Stellar-side ZK verification + minimal job ledger. Verifies an
`AgentCredentialProof` Groth16 proof produced by `circuits/` (T4), claims
the per-skill nullifier (replay guard), and records the job.

## Layout

```
contracts-soroban/agent_credential_verifier/
  Cargo.toml          soroban-sdk 26 + Arkworks Groth16/Bn254 (no_std)
  src/lib.rs          contract: constructor, register_skill, create_job, views
  src/test.rs         host-side tests (cargo test --features testutils)
```

## Build + test

```bash
# Host-side test suite (6 cases — constructor, admin gate, schema invariants)
cargo test --features testutils

# Deployable WASM
cargo build --target wasm32v1-none --release
# → target/wasm32v1-none/release/agent_credential_verifier.wasm  (~128 KB)
```

`wasm32v1-none` is the Soroban-supported target as of Rust 1.84+ (the older
`wasm32-unknown-unknown` enables features Soroban can't load — error
caught + flagged by `soroban-sdk/build.rs`).

## Interface

| Method                                                                 | Auth      | Purpose                                                    |
|------------------------------------------------------------------------|-----------|------------------------------------------------------------|
| `__constructor(admin: Address)`                                        | admin     | initialize once                                            |
| `register_skill(skill_id, vkey, min_reputation, price_per_call, owner)`| admin     | declare a skill + bind its Groth16 verifying key           |
| `create_job(payer, skill_id, task_commitment, proof, nullifier, public_inputs, x402_receipt) -> u64` | payer | verify proof, claim nullifier, record job |
| `is_nullifier_used(nullifier) -> bool`                                 | any       | replay-guard read                                          |
| `get_skill(skill_id) -> Option<SkillConfig>`                           | any       | read-only                                                  |
| `get_job(job_id) -> Option<JobRecord>`                                 | any       | read-only                                                  |
| `job_count() -> u64`                                                   | any       | read-only                                                  |
| `admin() -> Option<Address>`                                           | any       | read-only                                                  |

## Public-signal contract (must match `circuits/src/agent_credential.circom`)

`create_job` expects `public_inputs` as a 5-element `Vec<BytesN<32>>` in
this order, matching `circuit main { public [...] }`:

```
[ skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot ]
```

A test in `circuits/test/agent_credential.test.mjs` asserts the circuit
emits public signals in this exact order; the contract's `create_job` checks
`pi_skill == skill_id`, `pi_min_rep == skill.min_reputation`, and
`pi_nullifier == nullifier` before invoking the Groth16 verifier.

## Why Arkworks Groth16 (not native BN254 host functions)

Stellar Protocol 26 ("Yardstick") exposes BN254 scalar arithmetic and MSM
(CAP-0074), but pairing and `g1_add` are not yet native host functions on
`stellar/rs-soroban-env` (tracked publicly). The Arkworks `ark-bn254` +
`ark-groth16` crates run no_std and verify ~1 proof per call comfortably,
matching the UltraHonk verifier pattern in `noir-lang/discussions/8509`.
When stellar ships `bn254_pairing`, the `crypto::verify_groth16` helper in
`src/lib.rs` is the only swap point.

## Deploy

Deploy step is owner-driven (Stellar CLI / RPC):

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_credential_verifier.wasm \
  --network testnet \
  --source $DEPLOYER_KEY
```

Then call `register_skill` once with the verifying-key bytes produced by
`circuits/build/agent_credential/verification_key.json` (T8 wires the
snarkjs → Arkworks-canonical conversion utility).
