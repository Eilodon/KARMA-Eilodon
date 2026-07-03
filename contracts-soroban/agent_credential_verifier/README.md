# `agent_credential_verifier` — Soroban verifier contract (T5)

KARMA's Stellar-side ZK verification + minimal job ledger. Verifies an
`AgentCredentialProof` Groth16 proof produced by `circuits/` (T4), claims
the per-skill nullifier (replay guard), and records the job.

## Layout

```
contracts-soroban/agent_credential_verifier/
  Cargo.toml          soroban-sdk 26 only — no Arkworks (no_std)
  src/lib.rs          contract: constructor, register_skill, create_job, views
  src/test.rs         host-side tests (cargo test --features testutils)
```

## Build + test

```bash
# Host-side test suite (12 cases — constructor, admin gate, schema invariants, job-history-root
# pinning, and real native bn254_multi_pairing_check calls against both a satisfying real-circuit
# proof and a well-formed-but-non-satisfying proof)
cargo test --features testutils

# Deployable WASM
cargo build --target wasm32v1-none --release
# → target/wasm32v1-none/release/agent_credential_verifier.wasm  (~28 KB)
```

`wasm32v1-none` is the Soroban-supported target as of Rust 1.84+ (the older
`wasm32-unknown-unknown` enables features Soroban can't load — error
caught + flagged by `soroban-sdk/build.rs`).

## Interface

| Method                                                                 | Auth      | Purpose                                                    |
|------------------------------------------------------------------------|-----------|------------------------------------------------------------|
| `__constructor(admin: Address)`                                        | admin     | initialize once                                            |
| `register_skill(skill_id, vkey, min_reputation, price_per_call, owner)`| admin     | declare a skill + bind its Groth16 verifying key           |
| `set_skill_root(skill_id, root)`                                       | admin     | publish/rotate the skill's job-history Merkle root         |
| `create_job(payer, skill_id, task_commitment, proof, nullifier, public_inputs, x402_receipt) -> u64` | payer | verify proof, claim nullifier, record job |
| `is_nullifier_used(nullifier) -> bool`                                 | any       | replay-guard read                                          |
| `get_skill(skill_id) -> Option<SkillConfig>`                           | any       | read-only                                                  |
| `skill_root(skill_id) -> Option<BytesN<32>>`                           | any       | read-only                                                  |
| `get_job(job_id) -> Option<JobRecord>`                                 | any       | read-only                                                  |
| `job_count() -> u64`                                                   | any       | read-only                                                  |
| `admin() -> Option<Address>`                                           | any       | read-only                                                  |

## Public-signal contract (must match `circuits/src/agent_credential.circom`)

`create_job` expects `public_inputs` as a 5-element `Vec<Bn254Fr>`
(`soroban_sdk::crypto::bn254::Bn254Fr`) in this order, matching
`circuit main { public [...] }`:

```
[ skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot ]
```

A test in `circuits/test/agent_credential.test.mjs` asserts the circuit
emits public signals in this exact order; the contract's `create_job` checks
`pi_skill == skill_id`, `pi_min_rep == skill.min_reputation`,
`pi_nullifier == nullifier`, and `pi_root == skill_root(skill_id)` (published
via `set_skill_root`, panics `SkillRootNotSet`/`JobHistoryRootMismatch`
otherwise) before invoking the Groth16 verifier. `skillId` and
`minReputation` are packed as big-endian integers in the low-order bytes of
their `Bn254Fr` (see `crypto::fr_from_u64`/`fr_from_u32`); `nullifier` and
`jobHistoryRoot` are compared via `Bn254Fr::from_bytes(...)`.
`credentialCommitment` (`public_inputs[3]`) is not separately pinned on-chain
— it doesn't need to be, since the circuit's Merkle proof already binds it to
a leaf under the pinned `jobHistoryRoot`, and the leaf itself binds the
committed `reputationScore` (`Poseidon(credentialSecret, reputationScore)`),
so a prover cannot attach an arbitrary self-declared score.

## Groth16 verification: native BN254 host functions

The pairing check runs entirely on Stellar's native BN254 host functions —
`env.crypto().bn254()`, backed by `bn254_multi_pairing_check`
([CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md),
shipped in Protocol 25 "X-Ray"), plus `g1_add`/`g1_mul` for the `vk_x`
linear combination. Same equation as Stellar's canonical `groth16_verifier`
example (BLS12-381), over BN254 instead:

```
e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
```

`VerifyingKey` / `Groth16Proof` are typed structs of `Bn254G1Affine` /
`Bn254G2Affine` (see `soroban_sdk::crypto::bn254`) — no Arkworks dependency,
no heap allocator, no in-contract elliptic-curve arithmetic. This contract
previously shipped a software `ark-bn254` + `ark-groth16` verifier under the
assumption that CAP-0074's pairing check wasn't available yet; that
assumption predated Protocol 25 and was corrected once verified against the
live CAP text and `soroban-sdk` 26 API (see `docs/decisions/DP-7`).

Point encoding is the host's Ethereum-compatible uncompressed format:
- G1 (`Bn254G1Affine`, 64 bytes): `BE(X) || BE(Y)`
- G2 (`Bn254G2Affine`, 128 bytes): `BE(X) || BE(Y)`, where each `Fp2`
  coordinate is `BE(c1) || BE(c0)` (imaginary component first — matches the
  `bn256Pairing` precompile test-vector convention `test.rs` reuses).

## Deploy

Deploy step is owner-driven (Stellar CLI / RPC):

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_credential_verifier.wasm \
  --network testnet \
  --source $DEPLOYER_KEY
```

Then call `register_skill` once with a `VerifyingKey` built from
`circuits/build/agent_credential/verification_key.json` via
`circuits/scripts/pack-bn254.mjs` (T8 — decimal-string coordinates packed to
fixed-width big-endian bytes, no custom EC-point serialization needed):

```bash
node circuits/scripts/pack-bn254.mjs \
  circuits/build/agent_credential/verification_key.json \
  circuits/build/agent_credential/happy.proof.json \
  circuits/build/agent_credential/happy.public.json \
  /tmp/agent_credential_packed.json
stellar contract invoke --id $VERIFIER_ID --source $DEPLOYER_KEY --network testnet \
  -- register_skill --skill_id 42 \
  --vkey "$(jq -c .vkey /tmp/agent_credential_packed.json)" \
  --min_reputation 60 --price_per_call 100000 --owner $PROVIDER_ADDRESS

# Then publish the job-history root — create_job reverts SkillRootNotSet without this.
stellar contract invoke --id $VERIFIER_ID --source $DEPLOYER_KEY --network testnet \
  -- set_skill_root --skill_id 42 \
  --root "$(jq -r '.public_inputs[4]' /tmp/agent_credential_packed.json)"
```

See `DEMO_STELLAR.md` for the full live-deploy walkthrough (including
`create_job`) and the currently-live contract ID.
