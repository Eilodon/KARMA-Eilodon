# `reputation_aggregation_verifier` — Soroban verifier contract (T1.1)

Sibling of [`agent_credential_verifier`](../agent_credential_verifier) (T5), **not** a
replacement — the two prove different facts and intentionally live in separate contracts
so audit + nullifier domains stay disjoint:

| Contract | Proves |
|---|---|
| `agent_credential_verifier` | single-skill access gate ("rep ≥ X for skill Y") |
| `reputation_aggregation_verifier` | portfolio credential ("rep ≥ X avg across ≥ K distinct categories over ≥ N jobs in epoch E") |

A marketplace skill that demands a "trust tier" credential before exposing a high-value
endpoint verifies a `ReputationAggregationProof` here; the resulting `CredentialRecord`
(indexed by nullifier) is what the skill provider reads off-chain.

## Layout

```
contracts-soroban/reputation_aggregation_verifier/
  Cargo.toml          soroban-sdk 26 only — no Arkworks (no_std)
  src/lib.rs          contract: constructor, set_vkey, set_epoch_root, submit_proof, views
  src/test.rs         host-side tests (cargo test --features testutils)
```

## Build + test

```bash
# 19 tests — constructor, admin gate, schema invariants, a real native
# bn254_multi_pairing_check call against a well-formed-but-non-satisfying proof, the
# cross-chain-reputation consumer, and a real circuit-generated happy path (a genuine
# ReputationAggregationProof from `make repagg`, packed via pack-bn254.mjs) + its replay guard.
cargo test --features testutils

# Deployable WASM
cargo build --target wasm32v1-none --release
```

## Groth16 verification: native BN254 host functions

Same path as `agent_credential_verifier` — the pairing check runs on Stellar's native BN254
host functions (`env.crypto().bn254()`, `bn254_multi_pairing_check`,
[CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md),
Protocol 25 "X-Ray"), not a software Arkworks fallback. `VerifyingKey` / `Groth16Proof` are
typed structs of `Bn254G1Affine` / `Bn254G2Affine`; see
`contracts-soroban/agent_credential_verifier/README.md` for the exact point-encoding spec
(both verifiers share it) and `docs/decisions/DP-7` for why this replaced the earlier
software verifier.

## Public-signal contract (must match `circuits/src/reputation_aggregation.circom`)

`submit_proof` expects `public_inputs` as a 5-element `Vec<Bn254Fr>` in this order:

```
[ minAvgScore, minDistinctCategories, minJobs, nullifier, epochRoot ]
```

asserted by `circuits/test/reputation_aggregation.test.mjs`. `nullifier` and `epochRoot` are
compared via `Bn254Fr::from_bytes(...)` against the call's `nullifier` argument and the
admin-published root for `epoch_id`; `minAvgScore` / `minDistinctCategories` / `minJobs` are
read back out via `crypto::fr_to_u32` into the stored `CredentialRecord`.

## Interface

| Method | Auth | Purpose |
|---|---|---|
| `__constructor(admin: Address)` | admin | initialize once |
| `set_vkey(vkey: VerifyingKey)` | admin | bind the circuit's Groth16 verifying key (idempotent — can be set/replaced any time before first proof) |
| `set_epoch_root(epoch_id, root)` | admin | publish the Merkle root for an epoch |
| `submit_proof(agent, epoch_id, proof, nullifier, public_inputs) -> u64` | agent | verify proof, claim nullifier, mint `CredentialRecord` |
| `update_cross_chain_rep(agent, nullifier) -> u32` | agent | consume a verified credential into a queryable cross-chain reputation score |
| `admin_set_cross_chain_rep(agent, score)` | admin | bridge-attestation override for reputation verified on another chain |
| `cross_chain_rep(agent) -> Option<u32>` | any | read-only |
| `is_nullifier_used` / `get_credential` / `epoch_root` / `vkey_set` / `credential_count` / `admin` | any | read-only |

## Deploy

Owner-driven (Stellar CLI / RPC) — pack `circuits/build/reputation_aggregation/verification_key.json`
with `circuits/scripts/pack-bn254.mjs` the same way as `agent_credential_verifier`:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/reputation_aggregation_verifier.wasm \
  --network testnet --source $DEPLOYER_KEY

node circuits/scripts/pack-bn254.mjs \
  circuits/build/reputation_aggregation/verification_key.json \
  circuits/build/reputation_aggregation/happy.proof.json \
  circuits/build/reputation_aggregation/happy.public.json \
  /tmp/repagg_packed.json
stellar contract invoke --id $VERIFIER_ID --source $DEPLOYER_KEY --network testnet \
  -- set_vkey --vkey "$(jq -c .vkey /tmp/repagg_packed.json)"
```
